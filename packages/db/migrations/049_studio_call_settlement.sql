BEGIN;
CREATE TABLE IF NOT EXISTS hawa.studio_run_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  run_id uuid NOT NULL,
  action_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES hawa.users(id),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  calls jsonb NOT NULL CHECK(jsonb_typeof(calls)='array' AND jsonb_array_length(calls) BETWEEN 1 AND 1000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,task_id) REFERENCES hawa.tasks(tenant_id,id),
  UNIQUE(tenant_id,action_id)
);
ALTER TABLE hawa.studio_run_settlements ADD CONSTRAINT studio_settlement_task_client_fk FOREIGN KEY(tenant_id,task_id,client_id) REFERENCES hawa.tasks(tenant_id,id,client_id);
ALTER TABLE hawa.studio_run_settlements ADD CONSTRAINT studio_settlement_run_fk FOREIGN KEY(run_id) REFERENCES hawa.design_studio_runs(id);
CREATE INDEX studio_settlement_run_scope ON hawa.studio_run_settlements(tenant_id,run_id);
ALTER TABLE hawa.studio_run_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.studio_run_settlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS studio_settlements_read ON hawa.studio_run_settlements;
CREATE POLICY studio_settlements_read ON hawa.studio_run_settlements FOR SELECT USING
  (tenant_id=hawa.current_tenant_id() AND
   (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','designer']::hawa.membership_role[])));
DROP POLICY IF EXISTS studio_settlements_insert ON hawa.studio_run_settlements;
CREATE POLICY studio_settlements_insert ON hawa.studio_run_settlements FOR INSERT WITH CHECK
  (tenant_id=hawa.current_tenant_id() AND actor_user_id=hawa.current_user_id() AND
   (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator']::hawa.membership_role[])));
GRANT SELECT,INSERT ON hawa.studio_run_settlements TO hawa_app;
REVOKE UPDATE,DELETE ON hawa.studio_run_settlements FROM hawa_app;

CREATE FUNCTION hawa.protect_studio_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry jsonb; unresolved_count integer; run_row hawa.design_studio_runs%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Studio settlements are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hawa.lock_named_office_administrator(NEW.tenant_id,
    current_setting('hawa.studio_settlement_session_hash',true),NEW.actor_user_id)) THEN
    RAISE EXCEPTION 'Named administrator session required for Studio settlement';
  END IF;
  PERFORM 1 FROM hawa.tasks WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id AND client_id=NEW.client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Studio settlement task scope mismatch'; END IF;
  SELECT * INTO run_row FROM hawa.design_studio_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
  IF NOT FOUND OR run_row.task_id<>NEW.task_id OR run_row.client_id<>NEW.client_id THEN
    RAISE EXCEPTION 'Studio settlement run scope mismatch';
  END IF;
  IF run_row.status NOT IN ('abandoned','failed','degraded','transferred') THEN
    RAISE EXCEPTION 'Stop the Studio run through its owner before settlement';
  END IF;
  PERFORM 1 FROM hawa.design_studio_calls WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id FOR UPDATE;
  SELECT count(*) INTO unresolved_count FROM hawa.design_studio_calls c
    WHERE c.tenant_id=NEW.tenant_id AND c.run_id=NEW.run_id AND c.status='uncertain'
      AND NOT EXISTS(SELECT 1 FROM hawa.studio_run_settlements s WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id
        AND s.calls @> jsonb_build_array(jsonb_build_object('callId',c.id::text)));
  IF unresolved_count=0 OR jsonb_array_length(NEW.calls)<>unresolved_count OR
    (SELECT count(DISTINCT e->>'callId') FROM jsonb_array_elements(NEW.calls) e)<>unresolved_count THEN
    RAISE EXCEPTION 'Settlement must cover every unresolved Studio call exactly once';
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
      NOT EXISTS(SELECT 1 FROM hawa.design_studio_calls c WHERE c.tenant_id=NEW.tenant_id AND c.run_id=NEW.run_id
        AND c.id::text=entry->>'callId' AND c.status='uncertain' AND NOT EXISTS(
          SELECT 1 FROM hawa.studio_run_settlements s WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id
            AND s.calls @> jsonb_build_array(jsonb_build_object('callId',c.id::text)))) THEN
      RAISE EXCEPTION 'Terminal provider evidence and known cost required for unresolved Studio calls';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_studio_settlement BEFORE INSERT OR UPDATE OR DELETE ON hawa.studio_run_settlements
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_studio_settlement();
COMMIT;
