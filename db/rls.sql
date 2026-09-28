-- Hawa Creative OS row-level security.
-- The API sets these inside every transaction:
--   SET LOCAL app.tenant_id = '<uuid>';
--   SET LOCAL app.user_id = '<uuid>';
-- Service identities must still set tenant and use narrowly granted functions.

BEGIN;
SET search_path = hawa, public;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION is_tenant_member(tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM tenant_memberships m
       WHERE m.tenant_id = tid AND m.user_id = current_user_id() AND m.active
     )
$$;

CREATE OR REPLACE FUNCTION has_tenant_role(tid uuid, roles membership_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM tenant_memberships m
       WHERE m.tenant_id = tid AND m.user_id = current_user_id() AND m.active AND m.role = ANY(roles)
     )
$$;

CREATE OR REPLACE FUNCTION can_access_client(tid uuid, cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = current_tenant_id()
     AND (
       has_tenant_role(tid, ARRAY['administrator','auditor','operator']::membership_role[])
       OR EXISTS (
         SELECT 1 FROM client_memberships cm
         WHERE cm.tenant_id=tid AND cm.client_id=cid AND cm.user_id=current_user_id() AND cm.active
       )
     )
$$;

CREATE OR REPLACE FUNCTION can_write_client(tid uuid, cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = current_tenant_id()
     AND (
       has_tenant_role(tid, ARRAY['administrator','operator']::membership_role[])
       OR EXISTS (
         SELECT 1 FROM client_memberships cm
         WHERE cm.tenant_id=tid AND cm.client_id=cid AND cm.user_id=current_user_id() AND cm.active
           AND cm.role = ANY(ARRAY['designer','client_dna_manager']::membership_role[])
       )
     )
$$;

-- Tenant-level tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integrations','integration_health','channel_routes','inbox_events','message_events','message_attachments',
    'outbox_commands','eval_datasets','eval_cases','eval_runs','backup_drills'
  ] LOOP
    EXECUTE format('ALTER TABLE hawa.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hawa.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_tenant_select ON hawa.%I FOR SELECT USING (hawa.is_tenant_member(tenant_id))', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_write ON hawa.%I FOR ALL USING (hawa.has_tenant_role(tenant_id, ARRAY[''administrator'',''operator'']::hawa.membership_role[])) WITH CHECK (hawa.has_tenant_role(tenant_id, ARRAY[''administrator'',''operator'']::hawa.membership_role[]))', t, t);
  END LOOP;
END $$;

-- Client-scoped tables with direct client_id (and clients using id).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clients','projects','client_dna_versions','client_rules',
    'glossary_terms','brand_assets','templates','visual_examples','knowledge_documents','knowledge_chunks',
    'feedback_events'
  ] LOOP
    EXECUTE format('ALTER TABLE hawa.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hawa.%I FORCE ROW LEVEL SECURITY', t);
    IF t = 'clients' THEN
      EXECUTE format('CREATE POLICY %I_client_select ON hawa.%I FOR SELECT USING (hawa.can_access_client(tenant_id, id))', t, t);
      EXECUTE format('CREATE POLICY %I_client_write ON hawa.%I FOR ALL USING (hawa.can_write_client(tenant_id, id)) WITH CHECK (hawa.can_write_client(tenant_id, id))', t, t);
    ELSE
      EXECUTE format('CREATE POLICY %I_client_select ON hawa.%I FOR SELECT USING (hawa.can_access_client(tenant_id, client_id))', t, t);
      EXECUTE format('CREATE POLICY %I_client_write ON hawa.%I FOR ALL USING (hawa.can_write_client(tenant_id, client_id)) WITH CHECK (hawa.can_write_client(tenant_id, client_id))', t, t);
    END IF;
  END LOOP;
END $$;

-- Task-scoped tables derive access through the task.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_select ON tasks FOR SELECT USING (
  tenant_id=current_tenant_id() AND (
    client_id IS NULL AND is_tenant_member(tenant_id)
    OR client_id IS NOT NULL AND can_access_client(tenant_id,client_id)
  )
);
CREATE POLICY tasks_write ON tasks FOR ALL USING (
  tenant_id=current_tenant_id() AND (
    client_id IS NULL AND has_tenant_role(tenant_id,ARRAY['administrator','operator','requester']::membership_role[])
    OR client_id IS NOT NULL AND can_write_client(tenant_id,client_id)
  )
) WITH CHECK (tenant_id=current_tenant_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'task_events','design_briefs','design_plans','design_documents','design_revisions','artifacts',
    'qc_runs','review_requests','approvals','publications','sheet_syncs','model_invocations','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE hawa.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hawa.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %I_task_select ON hawa.%I FOR SELECT USING (
        tenant_id=hawa.current_tenant_id() AND EXISTS (
          SELECT 1 FROM hawa.tasks tx WHERE tx.id=%I.task_id
        )
      )$p$, t, t, t);
    EXECUTE format($p$
      CREATE POLICY %I_task_write ON hawa.%I FOR ALL USING (
        tenant_id=hawa.current_tenant_id() AND EXISTS (
          SELECT 1 FROM hawa.tasks tx WHERE tx.id=%I.task_id
            AND (tx.client_id IS NULL OR hawa.can_write_client(tx.tenant_id,tx.client_id))
        )
      ) WITH CHECK (tenant_id=hawa.current_tenant_id())$p$, t, t, t);
  END LOOP;
END $$;

-- Tables without tenant_id or with indirect scopes get explicit policies/grants.
-- Membership tables intentionally are not FORCE RLS: SECURITY DEFINER helper
-- functions owned by the migration owner must read them without recursive policies.
-- Application roles do not own the tables and remain subject to RLS.
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_memberships_select ON tenant_memberships FOR SELECT USING (
  tenant_id=current_tenant_id() AND (user_id=current_user_id() OR has_tenant_role(tenant_id,ARRAY['administrator','auditor']::membership_role[]))
);
CREATE POLICY tenant_memberships_admin ON tenant_memberships FOR ALL USING (has_tenant_role(tenant_id,ARRAY['administrator']::membership_role[])) WITH CHECK (has_tenant_role(tenant_id,ARRAY['administrator']::membership_role[]));

ALTER TABLE client_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_memberships_select ON client_memberships FOR SELECT USING (
  tenant_id=current_tenant_id() AND (user_id=current_user_id() OR has_tenant_role(tenant_id,ARRAY['administrator','operator','auditor']::membership_role[]))
);
CREATE POLICY client_memberships_admin ON client_memberships FOR ALL USING (
  has_tenant_role(tenant_id,ARRAY['administrator']::membership_role[])
) WITH CHECK (has_tenant_role(tenant_id,ARRAY['administrator']::membership_role[]));

ALTER TABLE rule_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE rule_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_evidence_select ON rule_evidence FOR SELECT USING (
  EXISTS (SELECT 1 FROM client_rules r WHERE r.id=rule_evidence.rule_id AND can_access_client(r.tenant_id,r.client_id))
);
CREATE POLICY rule_evidence_write ON rule_evidence FOR ALL USING (
  EXISTS (SELECT 1 FROM client_rules r WHERE r.id=rule_evidence.rule_id AND can_write_client(r.tenant_id,r.client_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM client_rules r WHERE r.id=rule_evidence.rule_id AND can_write_client(r.tenant_id,r.client_id))
);

ALTER TABLE drive_upload_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_upload_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY drive_upload_reservations_operator_select ON drive_upload_reservations FOR SELECT USING (
  tenant_id=current_tenant_id() AND (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator','operator']::membership_role[]))
);
CREATE POLICY drive_upload_reservations_operator_insert ON drive_upload_reservations FOR INSERT WITH CHECK (
  tenant_id=current_tenant_id() AND (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator','operator']::membership_role[]))
);

ALTER TABLE drive_refs ENABLE ROW LEVEL SECURITY; ALTER TABLE drive_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY drive_refs_select ON drive_refs FOR SELECT USING (
  tenant_id=current_tenant_id() AND EXISTS (
    SELECT 1 FROM publications p JOIN tasks t ON t.id=p.task_id
    WHERE p.id=drive_refs.publication_id AND (t.client_id IS NULL OR can_access_client(t.tenant_id,t.client_id))
  )
);
CREATE POLICY drive_refs_write ON drive_refs FOR ALL USING (
  tenant_id=current_tenant_id() AND EXISTS (
    SELECT 1 FROM publications p JOIN tasks t ON t.id=p.task_id
    WHERE p.id=drive_refs.publication_id AND (t.client_id IS NULL OR can_write_client(t.tenant_id,t.client_id))
  )
) WITH CHECK (tenant_id=current_tenant_id());

ALTER TABLE design_operations ENABLE ROW LEVEL SECURITY; ALTER TABLE design_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY design_operations_select ON design_operations FOR SELECT USING (
  tenant_id=current_tenant_id() AND EXISTS (
    SELECT 1 FROM design_revisions d JOIN tasks t ON t.id=d.task_id
    WHERE d.id=design_operations.design_revision_id AND (t.client_id IS NULL OR can_access_client(t.tenant_id,t.client_id))
  )
);
CREATE POLICY design_operations_write ON design_operations FOR INSERT WITH CHECK (
  tenant_id=current_tenant_id() AND EXISTS (
    SELECT 1 FROM design_revisions d JOIN tasks t ON t.id=d.task_id
    WHERE d.id=design_operations.design_revision_id AND (t.client_id IS NULL OR can_write_client(t.tenant_id,t.client_id))
  )
);

ALTER TABLE qc_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE qc_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY qc_profiles_select ON qc_profiles FOR SELECT USING (tenant_id IS NULL OR is_tenant_member(tenant_id));
CREATE POLICY qc_profiles_write ON qc_profiles FOR ALL USING (tenant_id IS NOT NULL AND has_tenant_role(tenant_id,ARRAY['administrator','operator']::membership_role[])) WITH CHECK (tenant_id IS NOT NULL AND has_tenant_role(tenant_id,ARRAY['administrator','operator']::membership_role[]));

ALTER TABLE model_deployments ENABLE ROW LEVEL SECURITY; ALTER TABLE model_deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY model_deployments_select ON model_deployments FOR SELECT USING (tenant_id IS NULL OR is_tenant_member(tenant_id));
CREATE POLICY model_deployments_write ON model_deployments FOR ALL USING (tenant_id IS NOT NULL AND has_tenant_role(tenant_id,ARRAY['administrator','model_evaluator']::membership_role[])) WITH CHECK (tenant_id IS NOT NULL AND has_tenant_role(tenant_id,ARRAY['administrator','model_evaluator']::membership_role[]));

ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE prompt_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY prompt_versions_select ON prompt_versions FOR SELECT USING (tenant_id IS NULL OR is_tenant_member(tenant_id));
CREATE POLICY prompt_versions_write ON prompt_versions FOR ALL USING (tenant_id IS NOT NULL AND has_tenant_role(tenant_id,ARRAY['administrator','model_evaluator']::membership_role[])) WITH CHECK (tenant_id IS NOT NULL AND has_tenant_role(tenant_id,ARRAY['administrator','model_evaluator']::membership_role[]));

ALTER TABLE eval_results ENABLE ROW LEVEL SECURITY; ALTER TABLE eval_results FORCE ROW LEVEL SECURITY;
CREATE POLICY eval_results_select ON eval_results FOR SELECT USING (
  EXISTS (SELECT 1 FROM eval_runs r WHERE r.id=eval_results.eval_run_id AND (r.tenant_id IS NULL OR is_tenant_member(r.tenant_id)))
);
CREATE POLICY eval_results_write ON eval_results FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM eval_runs r WHERE r.id=eval_results.eval_run_id AND r.tenant_id IS NOT NULL AND has_tenant_role(r.tenant_id,ARRAY['administrator','model_evaluator']::membership_role[]))
);

-- hawa.task_files (migration 019, ADR-035) carries its own tenant policy there. hawa.blobs has no
-- tenant and no policy on purpose: routes authorise on the referencing row, never on a hash.

-- Global lookup tables are read-only to application roles; grants should be explicit.
-- `users`, `model_roles`, and `tenants` require API-layer endpoints or SECURITY DEFINER functions.


ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (id=current_tenant_id() AND is_tenant_member(id));
CREATE POLICY tenants_admin ON tenants FOR UPDATE USING (has_tenant_role(id,ARRAY['administrator']::membership_role[])) WITH CHECK (id=current_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_same_tenant_select ON users FOR SELECT USING (
  id=current_user_id() OR EXISTS (
    SELECT 1 FROM tenant_memberships me JOIN tenant_memberships them ON them.tenant_id=me.tenant_id
    WHERE me.user_id=current_user_id() AND me.active AND them.user_id=users.id AND them.active AND me.tenant_id=current_tenant_id()
  )
);

ALTER TABLE model_roles ENABLE ROW LEVEL SECURITY; ALTER TABLE model_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY model_roles_read ON model_roles FOR SELECT USING (current_tenant_id() IS NOT NULL);

-- ADR-084: fixture evaluation receipts are scoped from initial bootstrap too.
ALTER TABLE eval_model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_model_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY eval_model_calls_scope ON eval_model_calls FOR ALL
USING (tenant_id=current_tenant_id() AND
  (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator','operator']::membership_role[])))
WITH CHECK (tenant_id=current_tenant_id() AND
  (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator','operator']::membership_role[])));

-- ADR-085: named evidence that closes a held fixture run.
ALTER TABLE eval_run_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_run_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY eval_run_settlements_read ON eval_run_settlements FOR SELECT USING
  (tenant_id=current_tenant_id() AND
   (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator','operator']::membership_role[])));
CREATE POLICY eval_run_settlements_insert ON eval_run_settlements FOR INSERT WITH CHECK
  (tenant_id=current_tenant_id() AND actor_user_id=current_user_id() AND
   (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator']::membership_role[])));

-- ADR-087: named Studio settlement evidence.
ALTER TABLE studio_run_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_run_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_settlements_read ON studio_run_settlements FOR SELECT USING
  (tenant_id=current_tenant_id() AND
   (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator','operator','designer']::membership_role[])));
CREATE POLICY studio_settlements_insert ON studio_run_settlements FOR INSERT WITH CHECK
  (tenant_id=current_tenant_id() AND actor_user_id=current_user_id() AND
   (SELECT has_tenant_role(current_tenant_id(),ARRAY['administrator']::membership_role[])));
COMMIT;
