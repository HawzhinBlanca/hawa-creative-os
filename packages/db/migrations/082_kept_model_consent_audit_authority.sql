-- ADR242: preserve consent only from an exact approved human version pair.
BEGIN;
DO $$
DECLARE predicate text; policy_name text; restricted boolean; condition text;
BEGIN
  predicate := $p$
    tenant_id=hawa.current_tenant_id() AND client_id IS NOT NULL AND task_id IS NULL
    AND action='client.model_consent.kept' AND resource_type='client_dna_version'
    AND actor_type='user' AND actor_id=hawa.current_user_id()::text
    AND current_setting('hawa.current_role',true)='administrator'
    AND hawa.current_user_id() NOT IN
      ('00000000-0000-4000-b000-000000000010'::uuid,'00000000-0000-4000-b000-000000000011'::uuid)
    AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]))
    AND EXISTS (SELECT 1 FROM hawa.client_dna_versions d
      JOIN hawa.client_dna_versions p ON p.tenant_id=d.tenant_id AND p.client_id=d.client_id AND p.version=d.version-1
      WHERE d.id::text=audit_events.resource_id AND d.tenant_id=audit_events.tenant_id
        AND d.client_id=audit_events.client_id AND d.status='active' AND p.status='superseded'
        AND d.approved_by=hawa.current_user_id() AND d.created_by=hawa.current_user_id()
        AND p.approved_by IS NOT NULL AND p.approved_by NOT IN
          ('00000000-0000-4000-b000-000000000010'::uuid,'00000000-0000-4000-b000-000000000011'::uuid)
        AND d.content_hash=audit_events.after_hash AND p.content_hash=audit_events.before_hash
        AND jsonb_typeof(d.dna->'privacy')='object' AND jsonb_typeof(p.dna->'privacy')='object'
        AND d.dna->'privacy'=p.dna->'privacy'
        AND audit_events.data->'privacy'=p.dna->'privacy'
        AND audit_events.data->>'fromVersion'=p.version::text AND audit_events.data->>'toVersion'=d.version::text
        AND audit_events.data->>'previousApprovedBy'=p.approved_by::text
        AND audit_events.data->>'via' IN ('dna','snapshot','rollback')
        AND audit_events.data->'actor'->>'userId'=hawa.current_user_id()::text
        AND audit_events.data->'actor'->>'role'='administrator')
  $p$;
  FOREACH restricted IN ARRAY ARRAY[false,true] LOOP
    policy_name := CASE WHEN restricted THEN 'audit_events_kept_consent_guard' ELSE 'audit_events_kept_consent_insert' END;
    condition := CASE WHEN restricted THEN format('action<>''client.model_consent.kept'' OR (%s)',predicate) ELSE predicate END;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass AND polname=policy_name) THEN
      EXECUTE format('CREATE POLICY %I ON hawa.audit_events AS %s FOR INSERT WITH CHECK (%s)',
        policy_name,CASE WHEN restricted THEN 'RESTRICTIVE' ELSE 'PERMISSIVE' END,condition);
    ELSIF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass AND polname=policy_name
        AND (polcmd<>'a' OR polpermissive=restricted OR polroles<>ARRAY[0]::oid[])) THEN
      RAISE EXCEPTION 'Kept consent audit policy has unexpected authority; migration refused';
    ELSE
      EXECUTE format('ALTER POLICY %I ON hawa.audit_events WITH CHECK (%s)',policy_name,condition);
    END IF;
  END LOOP;
END $$;
COMMIT;
