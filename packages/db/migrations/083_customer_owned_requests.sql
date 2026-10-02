-- ADR259. New tables intentionally follow membership-table owner access: security
-- definer helpers must inspect grants without recursively evaluating their RLS.
BEGIN;
CREATE TABLE hawa.customer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  issuer text NOT NULL CHECK (issuer='https://bpqpexwekalrfrodjidn.supabase.co'),
  subject uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES hawa.users(id),
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  daily_job_limit integer NOT NULL DEFAULT 10 CHECK (daily_job_limit BETWEEN 1 AND 100),
  concurrent_job_limit integer NOT NULL DEFAULT 2 CHECK (concurrent_job_limit BETWEEN 1 AND 10),
  provisioned_by uuid NOT NULL REFERENCES hawa.users(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(issuer,subject), UNIQUE(user_id)
);
CREATE TABLE hawa.customer_client_grants (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  provisioned_by uuid NOT NULL REFERENCES hawa.users(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,client_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES hawa.customer_accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,client_id) REFERENCES hawa.clients(tenant_id,id)
);
CREATE TABLE hawa.customer_access_actions (
 tenant_id uuid NOT NULL REFERENCES hawa.tenants(id), action_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES hawa.users(id), request_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,action_id)
);
ALTER TABLE hawa.customer_access_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_access_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_access_actions_read ON hawa.customer_access_actions FOR SELECT USING (
 (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]))));
CREATE POLICY customer_access_actions_insert ON hawa.customer_access_actions FOR INSERT WITH CHECK (
 actor_id=hawa.current_user_id() AND (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]))));
GRANT SELECT,INSERT ON hawa.customer_access_actions TO hawa_app;
CREATE TRIGGER customer_access_actions_append_only BEFORE UPDATE OR DELETE ON hawa.customer_access_actions
 FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE TABLE hawa.customer_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  account_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES hawa.users(id),
  operation text NOT NULL, resource text NOT NULL, before_state jsonb, after_state jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_access_audit_append_only BEFORE UPDATE OR DELETE ON hawa.customer_access_audit
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE FUNCTION hawa.audit_customer_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Customer access version must advance once' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
      NEW.provisioned_by IS DISTINCT FROM OLD.provisioned_by OR
      (TG_TABLE_NAME='customer_accounts' AND (to_jsonb(NEW)->>'id' IS DISTINCT FROM to_jsonb(OLD)->>'id'
       OR to_jsonb(NEW)->>'subject' IS DISTINCT FROM to_jsonb(OLD)->>'subject'
       OR to_jsonb(NEW)->>'issuer' IS DISTINCT FROM to_jsonb(OLD)->>'issuer'
       OR to_jsonb(NEW)->>'user_id' IS DISTINCT FROM to_jsonb(OLD)->>'user_id')) OR
      (TG_TABLE_NAME='customer_client_grants' AND (to_jsonb(NEW)->>'account_id' IS DISTINCT FROM to_jsonb(OLD)->>'account_id'
       OR to_jsonb(NEW)->>'client_id' IS DISTINCT FROM to_jsonb(OLD)->>'client_id'))) THEN
    RAISE EXCEPTION 'Customer identity and selected scope are immutable' USING ERRCODE='23514';
  END IF;
  INSERT INTO hawa.customer_access_audit(tenant_id,account_id,actor_id,operation,resource,before_state,after_state)
    VALUES(NEW.tenant_id,COALESCE((to_jsonb(NEW)->>'account_id')::uuid,(to_jsonb(NEW)->>'id')::uuid),
      COALESCE(hawa.current_user_id(),NEW.provisioned_by),TG_OP,TG_TABLE_NAME,
      CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.audit_customer_access() FROM PUBLIC,hawa_app,hawa_worker;
CREATE TRIGGER customer_accounts_audit AFTER INSERT OR UPDATE ON hawa.customer_accounts
 FOR EACH ROW EXECUTE FUNCTION hawa.audit_customer_access();
CREATE TRIGGER customer_grants_audit AFTER INSERT OR UPDATE ON hawa.customer_client_grants
 FOR EACH ROW EXECUTE FUNCTION hawa.audit_customer_access();

-- This context getter is inlineable, like current_tenant_id(): an office NULL scope
-- must be visible to the planner. Qualify the only function/type instead of SET search_path.
CREATE FUNCTION hawa.current_customer_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT NULLIF(pg_catalog.current_setting('hawa.customer_id',true),'')::pg_catalog.uuid
$$;
CREATE FUNCTION hawa.customer_account_for_subject() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT a.id FROM hawa.customer_accounts a
 JOIN hawa.users u ON u.id=a.user_id AND u.disabled_at IS NULL
 WHERE a.tenant_id=hawa.current_tenant_id() AND a.active
 AND a.subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid
 AND a.issuer='https://bpqpexwekalrfrodjidn.supabase.co'
 AND EXISTS(SELECT 1 FROM hawa.tenant_memberships m WHERE m.tenant_id=a.tenant_id
   AND m.user_id=a.user_id AND m.active AND m.role='requester')
 AND NOT EXISTS(SELECT 1 FROM hawa.tenant_memberships m WHERE m.user_id=a.user_id AND m.active AND m.role<>'requester')
 AND NOT EXISTS(SELECT 1 FROM hawa.client_memberships m WHERE m.user_id=a.user_id AND m.active AND m.role<>'requester')
$$;
CREATE FUNCTION hawa.customer_can_request(cid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM hawa.customer_accounts a
 JOIN hawa.customer_client_grants g ON g.account_id=a.id AND g.tenant_id=a.tenant_id AND g.active
 JOIN hawa.clients c ON c.id=g.client_id AND c.tenant_id=g.tenant_id AND c.status='active'
 JOIN hawa.client_memberships m ON m.tenant_id=g.tenant_id AND m.client_id=g.client_id
   AND m.user_id=a.user_id AND m.active AND m.role='requester'
 WHERE a.id=hawa.current_customer_id() AND a.id=hawa.customer_account_for_subject()
 AND a.user_id=hawa.current_user_id() AND g.client_id=cid)
$$;
REVOKE ALL ON FUNCTION hawa.current_customer_id(),hawa.customer_account_for_subject(),hawa.customer_can_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.current_customer_id() TO hawa_app,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_account_for_subject() TO hawa_app;
-- Referenced by task policies even when the worker has no customer context.
GRANT EXECUTE ON FUNCTION hawa.customer_can_request(uuid) TO hawa_app,hawa_worker;

-- ADR033: row scope compares against one admitted-client set per statement.
-- A per-row SECURITY DEFINER call here blocks ordered keyset plans for office lists.
CREATE FUNCTION hawa.customer_request_client_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(array_agg(g.client_id),'{}'::uuid[]) FROM hawa.customer_accounts a
 JOIN hawa.customer_client_grants g ON g.account_id=a.id AND g.tenant_id=a.tenant_id AND g.active
 JOIN hawa.clients c ON c.id=g.client_id AND c.tenant_id=g.tenant_id AND c.status='active'
 JOIN hawa.client_memberships m ON m.tenant_id=g.tenant_id AND m.client_id=g.client_id
   AND m.user_id=a.user_id AND m.active AND m.role='requester'
 WHERE a.id=hawa.current_customer_id() AND a.id=hawa.customer_account_for_subject()
   AND a.user_id=hawa.current_user_id()
$$;
REVOKE ALL ON FUNCTION hawa.customer_request_client_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.customer_request_client_ids() TO hawa_app,hawa_worker;

-- Lock authorization rows until the same intake transaction commits. VOLATILE
-- rechecks after waiting on revocation; customers receive no UPDATE permission.
CREATE FUNCTION hawa.lock_customer_request_access(cid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a hawa.customer_accounts%ROWTYPE;
BEGIN
 SELECT * INTO a FROM hawa.customer_accounts WHERE id=hawa.current_customer_id()
 AND id=hawa.customer_account_for_subject() AND user_id=hawa.current_user_id() FOR UPDATE;
 IF NOT FOUND OR NOT a.active THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.users WHERE id=a.user_id AND disabled_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.tenant_memberships WHERE tenant_id=a.tenant_id AND user_id=a.user_id AND active AND role='requester' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.customer_client_grants WHERE tenant_id=a.tenant_id AND account_id=a.id AND client_id=cid AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.clients WHERE tenant_id=a.tenant_id AND id=cid AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.client_memberships WHERE tenant_id=a.tenant_id AND user_id=a.user_id AND client_id=cid AND active AND role='requester' FOR SHARE;
 IF NOT FOUND OR NOT hawa.customer_can_request(cid) THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION hawa.lock_customer_request_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lock_customer_request_access(uuid) TO hawa_app;

CREATE FUNCTION hawa.pin_customer_dna(cid uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v integer;
BEGIN
 IF NOT hawa.customer_can_request(cid) THEN RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 SELECT version INTO v FROM hawa.client_dna_versions WHERE tenant_id=hawa.current_tenant_id()
 AND client_id=cid AND status='active' FOR SHARE;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION hawa.pin_customer_dna(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.pin_customer_dna(uuid) TO hawa_app;

CREATE FUNCTION hawa.provision_customer_requester(account_id uuid, subject_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid := gen_random_uuid();
BEGIN
 IF hawa.current_customer_id() IS NOT NULL OR NOT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]) THEN
  RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
 END IF;
 INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(uid,account_id::text||'@customer.hawa.invalid','Workspace customer','customer:'||subject_id::text);
 INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(hawa.current_tenant_id(),uid,'requester');
 RETURN uid;
END $$;
REVOKE ALL ON FUNCTION hawa.provision_customer_requester(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.provision_customer_requester(uuid,uuid) TO hawa_app;
CREATE FUNCTION hawa.customer_job_counts() RETURNS TABLE(daily integer,concurrent integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() OR hawa.current_customer_id() IS NULL THEN
  RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT count(*) FILTER(WHERE created_at>=now()-interval '24 hours')::integer,
 count(*) FILTER(WHERE state NOT IN ('complete','cancelled','rejected'))::integer
 FROM hawa.tasks WHERE tenant_id=hawa.current_tenant_id() AND customer_account_id=hawa.current_customer_id();
END $$;
REVOKE ALL ON FUNCTION hawa.customer_job_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.customer_job_counts() TO hawa_app;

ALTER TABLE hawa.customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_client_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_access_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_accounts_read ON hawa.customer_accounts FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND (id=(SELECT hawa.customer_account_for_subject())
 OR (hawa.current_customer_id() IS NULL AND (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]))))));
CREATE POLICY customer_grants_read ON hawa.customer_client_grants FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND (account_id=(SELECT hawa.customer_account_for_subject())
 OR (hawa.current_customer_id() IS NULL AND (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[]))))));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_accounts','customer_client_grants'] LOOP
  EXECUTE format('CREATE POLICY %I_admin ON hawa.%I FOR ALL USING (hawa.current_customer_id() IS NULL AND (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY[''administrator'']::hawa.membership_role[])))) WITH CHECK (hawa.current_customer_id() IS NULL AND (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY[''administrator'']::hawa.membership_role[]))))',t,t);
 END LOOP;
END $$;
CREATE POLICY customer_access_audit_read ON hawa.customer_access_audit FOR SELECT USING (
 hawa.current_customer_id() IS NULL AND (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','auditor']::hawa.membership_role[]))));
GRANT SELECT,INSERT,UPDATE ON hawa.customer_accounts,hawa.customer_client_grants TO hawa_app;
GRANT SELECT ON hawa.customer_access_audit TO hawa_app;

ALTER TABLE hawa.tasks ADD COLUMN customer_account_id uuid;
ALTER TABLE hawa.tasks ADD CONSTRAINT tasks_customer_account_fk FOREIGN KEY(tenant_id,customer_account_id)
 REFERENCES hawa.customer_accounts(tenant_id,id);
CREATE INDEX tasks_customer_history ON hawa.tasks(tenant_id,customer_account_id,created_at DESC,id DESC)
 WHERE customer_account_id IS NOT NULL;
CREATE FUNCTION hawa.protect_customer_task_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.customer_account_id IS DISTINCT FROM OLD.customer_account_id OR
   (OLD.customer_account_id IS NOT NULL AND NEW.requested_by IS DISTINCT FROM OLD.requested_by) THEN
  RAISE EXCEPTION 'Customer task ownership is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.protect_customer_task_owner() FROM PUBLIC,hawa_app,hawa_worker;
CREATE TRIGGER customer_task_owner_immutable BEFORE UPDATE OF customer_account_id,requested_by ON hawa.tasks
 FOR EACH ROW EXECUTE FUNCTION hawa.protect_customer_task_owner();
-- CASE preserves the NULL office branch without the disjunction's near-zero
-- selectivity estimate (24 estimated / 5000 actual rows), which lost keyset plans.
-- The admitted-client set still runs once per statement. Both branches retain RLS.
CREATE POLICY customer_task_scope ON hawa.tasks AS RESTRICTIVE FOR ALL USING (
 CASE WHEN hawa.current_customer_id() IS NULL THEN true ELSE customer_account_id=hawa.current_customer_id()
 AND requested_by=hawa.current_user_id() AND client_id=ANY ((SELECT hawa.customer_request_client_ids())::uuid[]) END) WITH CHECK (
 CASE WHEN hawa.current_customer_id() IS NULL THEN true ELSE customer_account_id=hawa.current_customer_id()
 AND requested_by=hawa.current_user_id() AND client_id=ANY ((SELECT hawa.customer_request_client_ids())::uuid[]) END);
CREATE POLICY customer_task_create ON hawa.tasks FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND customer_account_id=hawa.current_customer_id()
 AND requested_by=hawa.current_user_id() AND client_id=ANY ((SELECT hawa.customer_request_client_ids())::uuid[])
 AND state='received' AND version=1 AND assigned_to IS NULL);
CREATE POLICY customer_event_create ON hawa.task_events FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND event_type='task.created' AND aggregate_version=1
 AND actor_type='user' AND actor_id=hawa.current_user_id()::text AND EXISTS(
 SELECT 1 FROM hawa.tasks t WHERE t.id=task_id AND t.tenant_id=task_events.tenant_id
 AND t.customer_account_id=hawa.current_customer_id()));
CREATE POLICY customer_outbox_create ON hawa.outbox_commands FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND command_type='task.created' AND aggregate_type='task' AND state='pending'
 AND EXISTS(SELECT 1 FROM hawa.tasks t WHERE t.id=aggregate_id AND t.tenant_id=outbox_commands.tenant_id
 AND t.customer_account_id=hawa.current_customer_id()));
CREATE POLICY customer_outbox_scope ON hawa.outbox_commands AS RESTRICTIVE FOR SELECT USING (
 hawa.current_customer_id() IS NULL OR EXISTS(SELECT 1 FROM hawa.tasks t
 WHERE t.id=aggregate_id AND t.tenant_id=outbox_commands.tenant_id AND t.customer_account_id=hawa.current_customer_id()));
-- Defense in depth: a customer transaction cannot use inherited office policies
-- to mutate operational data or enumerate tenant-wide operational tables.
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='hawa' AND c.relrowsecurity AND c.relkind='r' LOOP
  EXECUTE format('CREATE POLICY customer_no_update ON hawa.%I AS RESTRICTIVE FOR UPDATE USING (hawa.current_customer_id() IS NULL) WITH CHECK (hawa.current_customer_id() IS NULL)',t);
  EXECUTE format('CREATE POLICY customer_no_delete ON hawa.%I AS RESTRICTIVE FOR DELETE USING (hawa.current_customer_id() IS NULL)',t);
  IF t NOT IN ('tasks','task_events','outbox_commands') THEN
   EXECUTE format('CREATE POLICY customer_no_insert ON hawa.%I AS RESTRICTIVE FOR INSERT WITH CHECK (hawa.current_customer_id() IS NULL)',t);
  END IF;
  IF t NOT IN ('customer_accounts','customer_client_grants','tasks','task_events','outbox_commands','clients','projects','client_dna_versions') THEN
   EXECUTE format('CREATE POLICY customer_no_read ON hawa.%I AS RESTRICTIVE FOR SELECT USING (hawa.current_customer_id() IS NULL)',t);
  END IF;
 END LOOP;
END $$;
COMMIT;
