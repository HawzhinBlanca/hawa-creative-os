-- ADR-051: keep the pre-dispatch identity and first observed outcome as evidence.
BEGIN;

CREATE OR REPLACE FUNCTION hawa.protect_design_studio_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Design studio calls ledger is append-only';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.tenant_id, NEW.stage, NEW.provider, NEW.model,
      NEW.requested_model, NEW.call_ordinal, NEW.logical_call_sha256, NEW.started_at)
    IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.tenant_id, OLD.stage, OLD.provider, OLD.model,
      OLD.requested_model, OLD.call_ordinal, OLD.logical_call_sha256, OLD.started_at) THEN
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
