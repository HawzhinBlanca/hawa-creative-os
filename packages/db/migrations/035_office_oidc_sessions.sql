-- ADR-064: one-time authorization-code state and attributed office sessions.
BEGIN;
ALTER TABLE hawa.desk_sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'shared_key'
  CHECK (auth_method IN ('shared_key','google_oidc','telegram_miniapp'));
CREATE TABLE hawa.office_oidc_flows (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX office_oidc_flows_expiry ON hawa.office_oidc_flows(expires_at);
ALTER TABLE hawa.office_oidc_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.office_oidc_flows FORCE ROW LEVEL SECURITY;
CREATE POLICY office_oidc_flows_scope ON hawa.office_oidc_flows
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON hawa.office_oidc_flows TO hawa_app;
COMMIT;
