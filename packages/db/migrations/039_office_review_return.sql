-- ADR-065: safe, single-use navigation carried through Google sign-in.
BEGIN;
ALTER TABLE hawa.office_oidc_flows
  ADD COLUMN return_task_id uuid,
  ADD COLUMN return_revision_id uuid,
  ADD CONSTRAINT office_oidc_return_task_required
    CHECK (return_revision_id IS NULL OR return_task_id IS NOT NULL);
COMMIT;
