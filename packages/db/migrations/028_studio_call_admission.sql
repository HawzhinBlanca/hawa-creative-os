-- ADR-049: one database-admitted identity per Studio model call.
BEGIN;

ALTER TABLE hawa.design_studio_calls
  ADD COLUMN call_ordinal integer,
  ADD COLUMN logical_call_sha256 text,
  ADD CONSTRAINT design_studio_calls_positive_ordinal CHECK (call_ordinal IS NULL OR call_ordinal > 0),
  ADD CONSTRAINT design_studio_calls_logical_sha256 CHECK (logical_call_sha256 IS NULL OR logical_call_sha256 ~ '^[0-9a-f]{64}$');

-- Historical rows have no identity. Every new repository call supplies a digest; staged
-- generation also supplies an ordinal. PostgreSQL arbitrates concurrent insertions.
CREATE UNIQUE INDEX design_studio_calls_run_ordinal_unique
  ON hawa.design_studio_calls(run_id, call_ordinal) WHERE call_ordinal IS NOT NULL;
CREATE UNIQUE INDEX design_studio_calls_logical_sha256_unique
  ON hawa.design_studio_calls(run_id, logical_call_sha256) WHERE logical_call_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION hawa.protect_design_studio_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Design studio calls ledger is append-only';
  END IF;
  IF (NEW.run_id, NEW.tenant_id, NEW.stage, NEW.provider, NEW.model,
      NEW.requested_model, NEW.call_ordinal, NEW.logical_call_sha256)
    IS DISTINCT FROM
     (OLD.run_id, OLD.tenant_id, OLD.stage, OLD.provider, OLD.model,
      OLD.requested_model, OLD.call_ordinal, OLD.logical_call_sha256) THEN
    RAISE EXCEPTION 'Design studio call admission identity is immutable';
  END IF;
  IF OLD.status IN ('ok', 'error') THEN
    RAISE EXCEPTION 'Completed design studio call is immutable';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
