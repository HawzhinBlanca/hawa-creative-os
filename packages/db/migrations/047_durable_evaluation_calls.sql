BEGIN;
ALTER TABLE hawa.eval_runs ADD COLUMN IF NOT EXISTS action_id uuid;
ALTER TABLE hawa.eval_runs ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE hawa.eval_runs ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES hawa.users(id);
ALTER TABLE hawa.eval_runs ADD COLUMN IF NOT EXISTS name text;
CREATE UNIQUE INDEX IF NOT EXISTS eval_runs_action_key ON hawa.eval_runs(tenant_id,action_id);
CREATE UNIQUE INDEX IF NOT EXISTS eval_runs_tenant_identity ON hawa.eval_runs(tenant_id,id);
CREATE TABLE IF NOT EXISTS hawa.eval_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  role text NOT NULL,
  deployment jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','uncertain')),
  outcome jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY(tenant_id,run_id) REFERENCES hawa.eval_runs(tenant_id,id),
  UNIQUE(tenant_id,run_id,ordinal),
  CHECK ((status='pending' AND outcome IS NULL AND finished_at IS NULL) OR
         (status<>'pending' AND outcome IS NOT NULL AND finished_at IS NOT NULL))
);
ALTER TABLE hawa.eval_model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.eval_model_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eval_model_calls_scope ON hawa.eval_model_calls;
CREATE POLICY eval_model_calls_scope ON hawa.eval_model_calls FOR ALL
USING (tenant_id=hawa.current_tenant_id() AND
  (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])))
WITH CHECK (tenant_id=hawa.current_tenant_id() AND
  (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])));
CREATE OR REPLACE FUNCTION hawa.protect_eval_model_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Evaluation call ledger is append-only'; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.run_id,NEW.ordinal,NEW.request_hash,NEW.role,NEW.deployment,NEW.started_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.run_id,OLD.ordinal,OLD.request_hash,OLD.role,OLD.deployment,OLD.started_at)
    OR OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'Evaluation call identity and first outcome are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_eval_model_call ON hawa.eval_model_calls;
CREATE TRIGGER protect_eval_model_call BEFORE UPDATE OR DELETE ON hawa.eval_model_calls
FOR EACH ROW EXECUTE FUNCTION hawa.protect_eval_model_call();
CREATE OR REPLACE FUNCTION hawa.protect_keyed_eval_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action_id IS NOT NULL THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Keyed evaluation runs are retained'; END IF;
    IF (NEW.id,NEW.tenant_id,NEW.dataset_id,NEW.action_id,NEW.request_hash,NEW.actor_id,NEW.name,NEW.candidate,NEW.started_at)
      IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.dataset_id,OLD.action_id,OLD.request_hash,OLD.actor_id,OLD.name,OLD.candidate,OLD.started_at)
      OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'Evaluation run identity and first outcome are immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_keyed_eval_run ON hawa.eval_runs;
CREATE TRIGGER protect_keyed_eval_run BEFORE UPDATE OR DELETE ON hawa.eval_runs
FOR EACH ROW EXECUTE FUNCTION hawa.protect_keyed_eval_run();
REVOKE DELETE ON hawa.eval_model_calls FROM hawa_app;
GRANT SELECT,INSERT,UPDATE ON hawa.eval_model_calls TO hawa_app;
COMMIT;
