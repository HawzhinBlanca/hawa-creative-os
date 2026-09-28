-- ADR-122: a semantic substep identity and exact binding for every newly admitted Studio call.
-- Historical rows keep NULL and remain on ADR-111's ordered-prefix recovery.
BEGIN;

ALTER TABLE hawa.design_studio_calls
  ADD COLUMN substep_key text,
  ADD COLUMN substep_attempt integer,
  ADD COLUMN binding_text text,
  ADD COLUMN binding_sha256 text,
  ADD CONSTRAINT studio_substep_key_format CHECK (substep_key IS NULL OR
    substep_key ~ '^[a-z][a-z0-9_-]{0,39}(/[a-z0-9][a-z0-9._-]{0,63}){1,4}$'),
  ADD CONSTRAINT studio_substep_binding_complete CHECK (
    (substep_key IS NULL AND substep_attempt IS NULL AND binding_text IS NULL AND binding_sha256 IS NULL) OR
    (substep_key IS NOT NULL AND substep_attempt > 0
      AND octet_length(binding_text) <= 16384
      AND jsonb_typeof(binding_text::jsonb) = 'object'
      AND binding_text::jsonb->>'substep' = substep_key
      AND binding_sha256 = encode(digest(binding_text, 'sha256'), 'hex')));

-- One recorded attempt per substep and run: two processes cannot both admit the same attempt.
CREATE UNIQUE INDEX design_studio_calls_substep_attempt_unique
  ON hawa.design_studio_calls(run_id, substep_key, substep_attempt) WHERE substep_key IS NOT NULL;

CREATE OR REPLACE FUNCTION hawa.protect_design_studio_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Design studio calls ledger is append-only';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.tenant_id, NEW.stage, NEW.provider, NEW.model,
      NEW.requested_model, NEW.call_ordinal, NEW.logical_call_sha256, NEW.started_at, NEW.reservation,
      NEW.substep_key, NEW.substep_attempt, NEW.binding_text, NEW.binding_sha256)
    IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.tenant_id, OLD.stage, OLD.provider, OLD.model,
      OLD.requested_model, OLD.call_ordinal, OLD.logical_call_sha256, OLD.started_at, OLD.reservation,
      OLD.substep_key, OLD.substep_attempt, OLD.binding_text, OLD.binding_sha256) THEN
    RAISE EXCEPTION 'Design studio call identity is immutable';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed design studio call is immutable';
  END IF;
  IF NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'Design studio call update must record its first outcome';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
