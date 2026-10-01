-- ADR225: authorize new rows independently of RETURNING and serialize selected scope.
-- Preserve policy OIDs/roles, read policies, existing grants and hoisted membership plans.
BEGIN;
DO $$
DECLARE t text; predicate text;
BEGIN
  predicate := $p$
    tenant_id=hawa.current_tenant_id() AND (
      (client_id IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
        ARRAY['administrator','operator','requester']::hawa.membership_role[])))
      OR (client_id IS NOT NULL AND (
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
          ARRAY['administrator','operator']::hawa.membership_role[]))
        OR client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[])))
    )
  $p$;
  EXECUTE format('ALTER POLICY tasks_write ON hawa.tasks USING (%s) WITH CHECK (%s)',predicate,predicate);

  FOREACH t IN ARRAY ARRAY['task_events','design_briefs','design_plans','design_documents',
    'design_revisions','artifacts','qc_runs','review_requests','approvals','publications',
    'sheet_syncs','model_invocations','audit_events']
  LOOP
    predicate := format($p$
      tenant_id=hawa.current_tenant_id() AND EXISTS (
        SELECT 1 FROM hawa.tasks tx WHERE tx.id=%1$I.task_id AND tx.tenant_id=%1$I.tenant_id
          AND (
            (tx.client_id IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
              ARRAY['administrator','operator','requester']::hawa.membership_role[])))
            OR (tx.client_id IS NOT NULL AND (
              (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
                ARRAY['administrator','operator']::hawa.membership_role[]))
              OR tx.client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[])))
          )
      )
    $p$,t);
    EXECUTE format('ALTER POLICY %I ON hawa.%I USING (%s) WITH CHECK (%s)',t||'_task_write',t,predicate,predicate);
  END LOOP;

  predicate := $p$
    tenant_id=hawa.current_tenant_id() AND EXISTS (
      SELECT 1 FROM hawa.publications p JOIN hawa.tasks t ON t.id=p.task_id AND t.tenant_id=p.tenant_id
      WHERE p.id=drive_refs.publication_id AND p.tenant_id=drive_refs.tenant_id AND (
        (t.client_id IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
          ARRAY['administrator','operator','requester']::hawa.membership_role[])))
        OR (t.client_id IS NOT NULL AND (
          (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
            ARRAY['administrator','operator']::hawa.membership_role[]))
          OR t.client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[])))
      )
    )
  $p$;
  EXECUTE format('ALTER POLICY drive_refs_write ON hawa.drive_refs USING (%s) WITH CHECK (%s)',predicate,predicate);

  predicate := $p$
    tenant_id=hawa.current_tenant_id() AND EXISTS (
      SELECT 1 FROM hawa.design_revisions d JOIN hawa.tasks t ON t.id=d.task_id AND t.tenant_id=d.tenant_id
      WHERE d.id=design_operations.design_revision_id AND d.tenant_id=design_operations.tenant_id AND (
        (t.client_id IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
          ARRAY['administrator','operator','requester']::hawa.membership_role[])))
        OR (t.client_id IS NOT NULL AND (
          (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
            ARRAY['administrator','operator']::hawa.membership_role[]))
          OR t.client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[])))
      )
    )
  $p$;
  EXECUTE format('ALTER POLICY design_operations_write ON hawa.design_operations WITH CHECK (%s)',predicate);

  -- ADR192/193 already authorize these client-wide append-only records through
  -- restrictive policies. Supply their explicit permissive INSERT path after
  -- removing the old tenant-only task INSERT bypass; unrelated actions stay denied.
  predicate := $p$
    tenant_id=hawa.current_tenant_id() AND task_id IS NULL AND client_id IS NOT NULL
    AND action IN ('client_rule.promoted','client_rule.dismissed','client_rule.rolled_back')
    AND resource_type='candidate_rule' AND actor_type='user' AND actor_id=hawa.current_user_id()::text
    AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
      ARRAY['administrator','operator']::hawa.membership_role[]))
      OR client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[]))
  $p$;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass
      AND polname='audit_events_client_rule_insert') THEN
    EXECUTE format('CREATE POLICY audit_events_client_rule_insert ON hawa.audit_events FOR INSERT WITH CHECK (%s)',predicate);
  ELSIF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass
      AND polname='audit_events_client_rule_insert' AND (polcmd<>'a' OR NOT polpermissive OR polroles<>ARRAY[0]::oid[])) THEN
    RAISE EXCEPTION 'Client rule audit insert policy has unexpected authority; migration refused';
  ELSE
    EXECUTE format('ALTER POLICY audit_events_client_rule_insert ON hawa.audit_events WITH CHECK (%s)',predicate);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hawa.protect_selected_task_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Selected task tenant scope is immutable';
  END IF;
  IF OLD.client_id IS NOT NULL AND NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Selected task client scope is immutable';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.protect_selected_task_scope() FROM PUBLIC,hawa_app,hawa_worker;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hawa.tasks'::regclass
      AND tgname='selected_task_scope_immutable') THEN
    CREATE TRIGGER selected_task_scope_immutable BEFORE UPDATE OF tenant_id,client_id ON hawa.tasks
      FOR EACH ROW EXECUTE FUNCTION hawa.protect_selected_task_scope();
  ELSIF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hawa.tasks'::regclass
      AND tgname='selected_task_scope_immutable' AND
      (tgfoid<>'hawa.protect_selected_task_scope()'::regprocedure OR tgtype<>19 OR tgenabled<>'O'
        OR tgqual IS NOT NULL OR tgattr::text<>format('%s %s',
          (SELECT attnum FROM pg_attribute WHERE attrelid='hawa.tasks'::regclass AND attname='tenant_id'),
          (SELECT attnum FROM pg_attribute WHERE attrelid='hawa.tasks'::regclass AND attname='client_id')))) THEN
    RAISE EXCEPTION 'Selected task scope trigger has unexpected authority; migration refused';
  END IF;
END $$;
COMMIT;
