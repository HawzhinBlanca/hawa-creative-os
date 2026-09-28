-- ADR-091: immutable pre-dispatch quotes; old calls retain absent evidence.
BEGIN;

ALTER TABLE hawa.design_studio_calls
  ADD COLUMN reservation jsonb,
  ADD COLUMN cost_basis text CHECK (cost_basis IN ('usage','estimate','unavailable','not_accepted')),
  ADD CONSTRAINT studio_reservation_valid CHECK (reservation IS NULL OR ((
    jsonb_typeof(reservation) = 'object'
    AND reservation->>'version' = '1'
    AND jsonb_typeof(reservation->'usd') = 'number'
    AND (reservation->>'usd')::numeric > 0
    AND (reservation->>'usd')::numeric <= 9007199254
    AND reservation->>'requestSha256' ~ '^[0-9a-f]{64}$'
    AND reservation->>'policy' ~ '^[a-zA-Z0-9_.:-]{1,100}$'
    AND jsonb_typeof(reservation->'inputTokens') = 'number'
    AND jsonb_typeof(reservation->'outputTokens') = 'number'
    AND (reservation->>'inputTokens')::numeric >= 0
    AND (reservation->>'outputTokens')::numeric >= 1
    AND (reservation->>'inputTokens')::numeric = trunc((reservation->>'inputTokens')::numeric)
    AND (reservation->>'outputTokens')::numeric = trunc((reservation->>'outputTokens')::numeric)
    AND (reservation->>'usd')::numeric * 1000000 = trunc((reservation->>'usd')::numeric * 1000000)
    AND reservation ?& ARRAY['version','usd','requestSha256','policy','inputTokens','outputTokens']
  ) IS TRUE)),
  ADD CONSTRAINT studio_non_acceptance_cost CHECK (cost_basis IS DISTINCT FROM 'not_accepted' OR
    (status = 'error' AND usd_estimate = 0));


CREATE OR REPLACE FUNCTION hawa.protect_design_studio_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Design studio calls ledger is append-only';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.tenant_id, NEW.stage, NEW.provider, NEW.model,
      NEW.requested_model, NEW.call_ordinal, NEW.logical_call_sha256, NEW.started_at, NEW.reservation)
    IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.tenant_id, OLD.stage, OLD.provider, OLD.model,
      OLD.requested_model, OLD.call_ordinal, OLD.logical_call_sha256, OLD.started_at, OLD.reservation) THEN
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
