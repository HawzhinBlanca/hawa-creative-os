-- ADR-050: retain non-content provider receipt facts for Studio reconciliation.
BEGIN;

ALTER TABLE hawa.design_studio_calls
  ADD COLUMN served_model text,
  ADD COLUMN provider_request_id text,
  ADD COLUMN response_sha256 text,
  ADD COLUMN latency_ms integer,
  ADD COLUMN attempts integer,
  ADD CONSTRAINT design_studio_calls_response_sha256 CHECK
    (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT design_studio_calls_latency_nonnegative CHECK
    (latency_ms IS NULL OR latency_ms >= 0),
  ADD CONSTRAINT design_studio_calls_attempts_positive CHECK
    (attempts IS NULL OR attempts > 0);

COMMIT;
