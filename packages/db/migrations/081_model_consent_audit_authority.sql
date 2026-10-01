-- ADR226: purpose-specific consent audit authority; no tenant-only insert bypass.
BEGIN;
DO $$
DECLARE predicate text; policy_name text; restricted boolean; condition text;
BEGIN
  predicate := $p$
    tenant_id=hawa.current_tenant_id() AND client_id IS NOT NULL AND task_id IS NULL
    AND action IN ('client.model_consent.granted','client.model_consent.withdrawn')
    AND resource_type='client_dna_version' AND actor_type='user'
    AND actor_id=hawa.current_user_id()::text
    AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]))
    AND EXISTS (SELECT 1 FROM hawa.client_dna_versions d
      WHERE d.id::text=audit_events.resource_id AND d.tenant_id=audit_events.tenant_id
        AND d.client_id=audit_events.client_id AND d.approved_by=hawa.current_user_id()
        AND d.content_hash=audit_events.after_hash
        AND jsonb_typeof(d.dna->'privacy'->'allowedProviders')='array'
        AND CASE WHEN jsonb_typeof(d.dna->'privacy'->'allowedProviders')='array' THEN
          (audit_events.action='client.model_consent.granted'
            AND d.dna->'privacy'->>'modelEgressMode' IN ('approved_providers','evaluated_external_allowed')
            AND jsonb_array_length(d.dna->'privacy'->'allowedProviders')>0)
          OR (audit_events.action='client.model_consent.withdrawn'
            AND d.dna->'privacy'->>'modelEgressMode' IN ('none','local_only')
            AND jsonb_array_length(d.dna->'privacy'->'allowedProviders')=0)
          ELSE false END)
  $p$;
  FOREACH restricted IN ARRAY ARRAY[false,true] LOOP
    policy_name := CASE WHEN restricted THEN 'audit_events_model_consent_guard'
      ELSE 'audit_events_model_consent_insert' END;
    condition := CASE WHEN restricted THEN format(
      'action NOT IN (''client.model_consent.granted'',''client.model_consent.withdrawn'') OR (%s)',predicate)
      ELSE predicate END;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass AND polname=policy_name) THEN
      EXECUTE format('CREATE POLICY %I ON hawa.audit_events AS %s FOR INSERT WITH CHECK (%s)',
        policy_name,CASE WHEN restricted THEN 'RESTRICTIVE' ELSE 'PERMISSIVE' END,condition);
    ELSIF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass AND polname=policy_name
        AND (polcmd<>'a' OR polpermissive=restricted OR polroles<>ARRAY[0]::oid[])) THEN
      RAISE EXCEPTION 'Model consent audit policy has unexpected authority; migration refused';
    ELSE
      EXECUTE format('ALTER POLICY %I ON hawa.audit_events WITH CHECK (%s)',policy_name,condition);
    END IF;
  END LOOP;
END $$;
COMMIT;
