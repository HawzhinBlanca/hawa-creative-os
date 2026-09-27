BEGIN;
CREATE TABLE IF NOT EXISTS hawa.eval_run_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  action_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES hawa.users(id),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  calls jsonb NOT NULL CHECK(jsonb_typeof(calls)='array'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,run_id) REFERENCES hawa.eval_runs(tenant_id,id),
  UNIQUE(tenant_id,run_id),
  UNIQUE(tenant_id,action_id)
);
ALTER TABLE hawa.eval_run_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.eval_run_settlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eval_run_settlements_read ON hawa.eval_run_settlements;
CREATE POLICY eval_run_settlements_read ON hawa.eval_run_settlements FOR SELECT USING
  (tenant_id=hawa.current_tenant_id() AND
   (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])));
DROP POLICY IF EXISTS eval_run_settlements_insert ON hawa.eval_run_settlements;
CREATE POLICY eval_run_settlements_insert ON hawa.eval_run_settlements FOR INSERT WITH CHECK
  (tenant_id=hawa.current_tenant_id() AND actor_user_id=hawa.current_user_id() AND
   (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[])));
GRANT SELECT,INSERT ON hawa.eval_run_settlements TO hawa_app;
REVOKE UPDATE,DELETE ON hawa.eval_run_settlements FROM hawa_app;

CREATE FUNCTION hawa.protect_eval_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry jsonb; unsettled_count integer; run_finished timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Evaluation settlements are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hawa.lock_named_office_administrator(NEW.tenant_id,
    current_setting('hawa.eval_settlement_session_hash',true),NEW.actor_user_id)) THEN
    RAISE EXCEPTION 'Named administrator session required for evaluation settlement';
  END IF;
  SELECT completed_at INTO run_finished FROM hawa.eval_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id AND action_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keyed evaluation run required'; END IF;
  SELECT count(*) INTO unsettled_count FROM hawa.eval_model_calls
    WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id AND status IN ('pending','uncertain');
  IF run_finished IS NOT NULL AND unsettled_count=0 THEN RAISE EXCEPTION 'Evaluation has no unresolved work'; END IF;
  IF jsonb_array_length(NEW.calls)<>unsettled_count OR
    (SELECT count(DISTINCT e->>'callId') FROM jsonb_array_elements(NEW.calls) e)<>unsettled_count THEN
    RAISE EXCEPTION 'Settlement must cover every unresolved call exactly once';
  END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(NEW.calls) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR
      NOT (entry ?& ARRAY['callId','conclusion','reportedCostUsd','evidenceReference','evidenceSha256']) OR
      jsonb_typeof(entry->'conclusion') IS DISTINCT FROM 'string' OR
      entry->>'conclusion' NOT IN ('provider_not_accepted','provider_finished') OR
      jsonb_typeof(entry->'reportedCostUsd') IS DISTINCT FROM 'number' OR
      (entry->>'reportedCostUsd')::numeric NOT BETWEEN 0 AND 1000000 OR
      (entry->>'conclusion'='provider_not_accepted' AND (entry->>'reportedCostUsd')::numeric<>0) OR
      jsonb_typeof(entry->'evidenceReference') IS DISTINCT FROM 'string' OR
      NOT (entry->>'evidenceReference' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$') OR
      jsonb_typeof(entry->'evidenceSha256') IS DISTINCT FROM 'string' OR
      NOT (entry->>'evidenceSha256' ~ '^[a-f0-9]{64}$') OR
      NOT EXISTS(SELECT 1 FROM hawa.eval_model_calls WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id
        AND id::text=entry->>'callId' AND status IN ('pending','uncertain')) THEN
      RAISE EXCEPTION 'Terminal provider evidence and known cost required';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_eval_settlement BEFORE INSERT OR UPDATE OR DELETE ON hawa.eval_run_settlements
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_eval_settlement();

-- This fence remains authoritative even if a former executor loses its session lock.
CREATE FUNCTION hawa.fence_closed_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM hawa.eval_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM hawa.eval_run_settlements WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id) THEN
    RAISE EXCEPTION 'Closed evaluation cannot admit model work';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_closed_evaluation BEFORE INSERT ON hawa.eval_model_calls
  FOR EACH ROW EXECUTE FUNCTION hawa.fence_closed_evaluation();
COMMIT;
