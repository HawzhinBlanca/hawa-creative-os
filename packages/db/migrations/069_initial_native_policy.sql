-- ADR-126: an initial manual request's copy confirmation is an immutable task event, like ADR-113's.
-- Its frozen export policy stays current only while that confirmation, its own binding and the
-- active human-authored Client DNA are unchanged. Other policies cannot qualify such a task.
BEGIN;
CREATE OR REPLACE FUNCTION hawa.canva_export_policy_current(
 p_tenant uuid, p_client uuid, p_metadata jsonb
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE policy jsonb := p_metadata->'checkingPolicy'; current_row record; confirmation record; handoff jsonb;
BEGIN
 -- Callers supply the task identity from the operation row, never from request input.
 -- This also refuses historical captures that predate frozen checking policies.
 IF policy->>'kind' IS DISTINCT FROM 'revision_client_dna' AND EXISTS(
  SELECT 1 FROM hawa.task_events e JOIN hawa.tasks t ON t.tenant_id=e.tenant_id AND t.id=e.task_id
   WHERE t.tenant_id=p_tenant AND t.client_id=p_client AND t.id::text=p_metadata->>'taskId'
    AND e.event_type='task.created' AND COALESCE(e.data->'payload',e.data)->'studioOptions' ? 'parentTaskId'
 ) THEN RETURN false; END IF;
 IF policy->>'kind' IS DISTINCT FROM 'initial_client_dna' AND EXISTS(
  SELECT 1 FROM hawa.task_events e JOIN hawa.tasks t ON t.tenant_id=e.tenant_id AND t.id=e.task_id
   WHERE t.tenant_id=p_tenant AND t.client_id=p_client AND t.id::text=p_metadata->>'taskId'
    AND e.actor_type='user' AND e.data->'initialNativeCopy'->>'schemaVersion'='1'
 ) THEN RETURN false; END IF;
 IF policy->>'kind'='imported_source' AND EXISTS(
  SELECT 1 FROM hawa.canva_editable_sources s JOIN hawa.task_events e ON e.tenant_id=s.tenant_id AND e.task_id=s.task_id
   WHERE s.tenant_id=p_tenant AND s.client_id=p_client AND s.id::text=policy->>'sourceId'
    AND ((e.actor_type='user' AND (e.data->'revisionHandoff'->>'schemaVersion'='1' OR e.data->'initialNativeCopy'->>'schemaVersion'='1')) OR
      (e.event_type='task.created' AND COALESCE(e.data->'payload',e.data)->'studioOptions' ? 'parentTaskId'))
 ) THEN RETURN false; END IF;
 IF policy IS NULL OR policy->>'kind' NOT IN ('manual_client_dna','revision_client_dna','initial_client_dna') THEN RETURN true; END IF;
 IF policy->>'clientId' IS DISTINCT FROM p_client::text THEN RETURN false; END IF;
 IF policy->>'kind'='revision_client_dna' THEN
  IF p_metadata ? 'taskId' AND p_metadata->>'taskId' IS DISTINCT FROM policy->>'taskId' THEN RETURN false; END IF;
  SELECT e.id,e.data,e.actor_id INTO confirmation FROM hawa.task_events e
   JOIN hawa.tasks t ON t.tenant_id=e.tenant_id AND t.id=e.task_id AND t.client_id=p_client
   WHERE e.tenant_id=p_tenant AND e.task_id::text=policy->>'taskId'
    AND e.actor_type='user' AND e.data->'revisionHandoff'->>'schemaVersion'='1'
   ORDER BY e.aggregate_version DESC LIMIT 1;
  IF NOT FOUND OR confirmation.id::text IS DISTINCT FROM policy->>'confirmationEventId' OR
   confirmation.actor_id IS NULL OR confirmation.actor_id IN ('00000000-0000-4000-b000-000000000010','00000000-0000-4000-b000-000000000011')
   THEN RETURN false; END IF;
  handoff:=confirmation.data->'revisionHandoff';
  IF handoff->>'clientId' IS DISTINCT FROM p_client::text OR handoff->'copy' IS DISTINCT FROM policy->'copy' THEN RETURN false; END IF;
  PERFORM 1 FROM hawa.canva_bindings b WHERE b.tenant_id=p_tenant AND b.client_id=p_client
   AND b.id::text=handoff->>'bindingId' AND b.task_id::text=policy->>'taskId' AND b.status='bound'
   AND b.version::text=handoff->>'bindingVersion' AND b.canva_design_id=handoff->>'designId' FOR SHARE OF b;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM hawa.canva_bindings b JOIN hawa.tasks t ON t.id=b.task_id AND t.tenant_id=b.tenant_id AND t.client_id=b.client_id
   WHERE b.tenant_id=p_tenant AND b.client_id=p_client AND b.id::text=handoff->>'parentBindingId'
   AND b.task_id::text=handoff->>'parentTaskId' AND b.status='bound' AND b.version::text=handoff->>'parentBindingVersion'
   AND b.canva_design_id=handoff->>'parentDesignId' AND t.version::text=handoff->>'parentTaskVersion' FOR SHARE OF b,t;
  IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 IF policy->>'kind'='initial_client_dna' THEN
  IF p_metadata ? 'taskId' AND p_metadata->>'taskId' IS DISTINCT FROM policy->>'taskId' THEN RETURN false; END IF;
  SELECT e.id,e.data,e.actor_id INTO confirmation FROM hawa.task_events e
   JOIN hawa.tasks t ON t.tenant_id=e.tenant_id AND t.id=e.task_id AND t.client_id=p_client
   WHERE e.tenant_id=p_tenant AND e.task_id::text=policy->>'taskId'
    AND e.actor_type='user' AND e.data->'initialNativeCopy'->>'schemaVersion'='1'
   ORDER BY e.aggregate_version DESC LIMIT 1;
  IF NOT FOUND OR confirmation.id::text IS DISTINCT FROM policy->>'confirmationEventId' OR
   confirmation.actor_id IS NULL OR confirmation.actor_id IN ('00000000-0000-4000-b000-000000000010','00000000-0000-4000-b000-000000000011')
   THEN RETURN false; END IF;
  handoff:=confirmation.data->'initialNativeCopy';
  IF handoff->>'clientId' IS DISTINCT FROM p_client::text OR handoff->'copy' IS DISTINCT FROM policy->'copy' THEN RETURN false; END IF;
  -- The confirming request must still own the task; no parent design exists for an initial request.
  PERFORM 1 FROM hawa.canva_bindings b JOIN hawa.tasks t ON t.id=b.task_id AND t.tenant_id=b.tenant_id AND t.client_id=b.client_id
   WHERE b.tenant_id=p_tenant AND b.client_id=p_client
   AND b.id::text=handoff->>'bindingId' AND b.task_id::text=policy->>'taskId' AND b.status='bound'
   AND b.version::text=handoff->>'bindingVersion' AND b.canva_design_id=handoff->>'designId'
   AND t.request_id::text=handoff->>'requestId' FOR SHARE OF b;
  IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 SELECT version,content_hash,created_by INTO current_row FROM hawa.client_dna_versions
  WHERE tenant_id=p_tenant AND client_id=p_client AND status='active' ORDER BY version DESC LIMIT 1 FOR SHARE;
 RETURN FOUND AND current_row.created_by IS NOT NULL
  AND current_row.created_by NOT IN ('00000000-0000-4000-b000-000000000010'::uuid,'00000000-0000-4000-b000-000000000011'::uuid)
  AND current_row.version::text IS NOT DISTINCT FROM policy->>'dnaVersion'
  AND current_row.content_hash IS NOT DISTINCT FROM policy->>'dnaContentHash';
END;
$$;
COMMIT;
