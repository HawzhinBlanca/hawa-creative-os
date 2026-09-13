BEGIN;
-- Desk sessions survive a Core restart and can be revoked from any instance. Only a SHA-256 of the
-- bearer token is stored; the token itself exists in the operator's browser and in memory.
CREATE TABLE IF NOT EXISTS hawa.desk_sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  user_id uuid NOT NULL REFERENCES hawa.users(id),
  actor_id text NOT NULL,
  role text NOT NULL,
  display_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desk_sessions_expiry ON hawa.desk_sessions(expires_at);
ALTER TABLE hawa.desk_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.desk_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY desk_sessions_scope ON hawa.desk_sessions
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON hawa.desk_sessions TO hawa_app;
COMMIT;
