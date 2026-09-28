-- 024: append-only evidence for the office's scheduled paid model probe (R02).
-- A successful observation applies only to the exact key/model pair that was probed.
BEGIN;

CREATE TABLE IF NOT EXISTS hawa.paid_model_health_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  provider text NOT NULL CHECK (provider = 'openai'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('connected','unauthorized','billing_exhausted','rate_limited','unreachable','http_error')),
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paid_model_health_latest_idx
  ON hawa.paid_model_health_observations (tenant_id, provider, observed_at DESC, id DESC);

CREATE TRIGGER paid_model_health_observations_append_only BEFORE UPDATE OR DELETE
  ON hawa.paid_model_health_observations FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
ALTER TABLE hawa.paid_model_health_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.paid_model_health_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY paid_model_health_observations_operator_select ON hawa.paid_model_health_observations
  FOR SELECT USING (tenant_id = hawa.current_tenant_id() AND
    (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[])));
CREATE POLICY paid_model_health_observations_operator_insert ON hawa.paid_model_health_observations
  FOR INSERT WITH CHECK (tenant_id = hawa.current_tenant_id() AND
    (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[])));

REVOKE ALL ON hawa.paid_model_health_observations FROM PUBLIC;
REVOKE ALL ON hawa.paid_model_health_observations FROM hawa_app;
GRANT SELECT, INSERT ON hawa.paid_model_health_observations TO hawa_app;

COMMIT;
