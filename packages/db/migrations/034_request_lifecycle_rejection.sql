-- ADR-063: a rejected request is terminal and distinct from cancellation or manual review.
BEGIN;
ALTER TABLE hawa.requests DROP CONSTRAINT IF EXISTS requests_stage_check;
ALTER TABLE hawa.requests ADD CONSTRAINT requests_stage_check
  CHECK (stage IN ('designing','awaiting_answer','in_review','manual','approved','delivering','delivered','expired','cancelled','rejected'));
COMMIT;
