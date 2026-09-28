-- ADR-041: a revision or rejection before QA must not manufacture a failed QA run.
BEGIN;

ALTER TABLE hawa.review_requests ALTER COLUMN qc_run_id DROP NOT NULL;
ALTER TABLE hawa.approvals ALTER COLUMN qc_run_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'hawa.approvals'::regclass AND conname = 'approvals_approved_requires_qc'
  ) THEN
    ALTER TABLE hawa.approvals ADD CONSTRAINT approvals_approved_requires_qc
      CHECK (decision <> 'approved' OR qc_run_id IS NOT NULL);
  END IF;
END;
$$;

COMMIT;
