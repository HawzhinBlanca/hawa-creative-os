BEGIN;
-- ADR183: service database capabilities, independent of app context and HTTP credentials.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hawa_worker') THEN
    CREATE ROLE hawa_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hawa_worker' AND
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin)) OR
     EXISTS (SELECT 1 FROM pg_auth_members WHERE member='hawa_worker'::regrole) OR
     EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
       AND refobjid='hawa_worker'::regrole AND deptype='o') THEN
    RAISE EXCEPTION 'hawa_worker has unexpected authority; migration refused';
  END IF;
END $$;

GRANT USAGE ON SCHEMA hawa TO hawa_worker;
DO $$ BEGIN
  -- PUBLIC TEMP cannot be denied to one role. Preserve Core's existing capability explicitly.
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO hawa_app',current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hawa_worker',current_database());
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA hawa FROM hawa_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hawa FROM hawa_worker;
GRANT SELECT ON hawa.tenant_memberships, hawa.tasks, hawa.task_events,
  hawa.outbox_commands, hawa.inbox_events, hawa.integration_health,
  hawa.canva_export_bytes, hawa.design_studio_runs, hawa.design_studio_candidates,
  hawa.blobs TO hawa_worker;
GRANT SELECT (id, tenant_id, kind, name) ON hawa.integrations TO hawa_worker;
GRANT INSERT ON hawa.outbox_commands, hawa.inbox_events, hawa.integration_health TO hawa_worker;
GRANT INSERT (tenant_id, kind, name, config_public) ON hawa.integrations TO hawa_worker;
-- Existing permissive tenant policies still apply. Restrictive policies additionally prevent a
-- compromised worker from changing the office kill switch or creating provider configuration.
CREATE POLICY worker_poll_insert ON hawa.integrations AS RESTRICTIVE FOR INSERT TO hawa_worker
  WITH CHECK (kind='telegram' AND name ~ '^bot-([0-9]+|sha256-[a-f0-9]{16})$'
    AND config_public = '{"purpose":"getUpdates offset"}'::jsonb);
CREATE POLICY worker_poll_health_insert ON hawa.integration_health AS RESTRICTIVE FOR INSERT TO hawa_worker
  WITH CHECK (EXISTS (SELECT 1 FROM hawa.integrations i WHERE i.id=integration_id
    AND i.kind='telegram' AND i.name ~ '^bot-([0-9]+|sha256-[a-f0-9]{16})$'));
CREATE POLICY worker_poll_health_update ON hawa.integration_health AS RESTRICTIVE FOR UPDATE TO hawa_worker
  USING (EXISTS (SELECT 1 FROM hawa.integrations i WHERE i.id=integration_id
    AND i.kind='telegram' AND i.name ~ '^bot-([0-9]+|sha256-[a-f0-9]{16})$'))
  WITH CHECK (EXISTS (SELECT 1 FROM hawa.integrations i WHERE i.id=integration_id
    AND i.kind='telegram' AND i.name ~ '^bot-([0-9]+|sha256-[a-f0-9]{16})$'));
GRANT UPDATE (state, available_at, leased_until, attempts, last_error, delivered_at)
  ON hawa.outbox_commands TO hawa_worker;
GRANT UPDATE (cursor_value, detail, state, last_event_at, last_success_at, updated_at)
  ON hawa.integration_health TO hawa_worker;

-- PostgreSQL has no DENY overriding PUBLIC. Preserve exactly the Core permissions formerly
-- supplied by PUBLIC, then close that path for the worker. Existing explicit denials stay denied.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid, p.oid::regprocedure AS name,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hawa' AND p.prokind IN ('f','p')
  LOOP
    IF f.public_execute THEN EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO hawa_app',f.name); END IF;
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC,hawa_worker',f.name);
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA hawa REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.current_tenant_id(), hawa.current_user_id(),
  hawa.is_tenant_member(uuid), hawa.has_tenant_role(uuid,hawa.membership_role[]),
  hawa.can_access_client(uuid,uuid), hawa.can_write_client(uuid,uuid),
  hawa.member_client_ids(boolean) TO hawa_worker;
COMMIT;
