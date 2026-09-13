BEGIN;
-- A failed, uncertain or superseded plan can be retired by an operator so the task may be planned
-- again. The row and its evidence remain; only status, diagnostic and updated_at change.
ALTER TABLE hawa.canva_design_plans DROP CONSTRAINT canva_design_plans_status_check;
ALTER TABLE hawa.canva_design_plans ADD CONSTRAINT canva_design_plans_status_check
  CHECK(status IN ('planning','planned','failed','uncertain','abandoned'));
CREATE OR REPLACE FUNCTION hawa.protect_canva_plan_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Design planning evidence is append-only'; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.task_id,NEW.client_id,NEW.actor_id,NEW.request_key,NEW.request_hash,NEW.request)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.task_id,OLD.client_id,OLD.actor_id,OLD.request_key,OLD.request_hash,OLD.request)
    THEN RAISE EXCEPTION 'Design planning source or completed result is immutable'; END IF;
  IF OLD.status IN ('planned','failed','uncertain') THEN
    IF NEW.status='abandoned'
       AND NEW.result IS NOT DISTINCT FROM OLD.result
       AND NEW.source_content IS NOT DISTINCT FROM OLD.source_content
       AND NEW.source_sha256 IS NOT DISTINCT FROM OLD.source_sha256
       AND NEW.created_at=OLD.created_at THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Design planning source or completed result is immutable';
  END IF;
  IF OLD.status='abandoned' THEN RAISE EXCEPTION 'An abandoned plan is final'; END IF;
  RETURN NEW;
END $$;
COMMIT;
