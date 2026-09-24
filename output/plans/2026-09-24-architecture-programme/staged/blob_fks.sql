-- Architecture programme 3.1, release B (ADR-035, FILESTORE_DESIGN.md sections 2.3 and 5): foreign keys
-- from the hash columns the old Core already writes to hawa.blobs.
--
-- STAGED, NOT A MIGRATION YET. It moves into packages/db/migrations/ under the next free number (020 is
-- taken) only for release B, after the production copy backfill has run and verified clean: until then
-- production has no hawa.blobs rows, and this file would fail the deploy at its migrate step. At the move,
-- add it to the expected list in packages/db/test/schema-upgrade.test.ts.
--
-- The gate: VALIDATE fails the migration, before any container is swapped, while any row names a hash
-- the store has no row for (an incomplete copy, a missing file row, or a row copy leaves as it is).
-- `blob_backfill.ts --mode verify` counts exactly those rows in advance (blocksForeignKey, and
-- foreignKeyBlockers in the rehearsal receipt), so run it before the deploy and expect 0.
--
-- Each constraint is added NOT VALID (new rows are checked at once) and then validated against the rows
-- already there. The runner (packages/db/src/upgrade.ts) runs every file in one transaction, so the
-- lighter lock NOT VALID normally buys is held to commit anyway; the tables are small (the whole file
-- applied in under 0.1 s of wall time on the rehearsal copy of 2026-09-24's nightly dump, psql start
-- included), and a failed VALIDATE names its constraint and key.
--
-- Known blocker on production (PHASE3_EVIDENCE.md): one canva_design_plans row left by an orchestrator
-- test on 2026-09-14 holds a 21-byte source that is no PPTX. Copy leaves it, so its source_sha256 names
-- no file row and canva_plan_source_blob_fk fails to validate until the owner decides what to do with it.
--
-- The columns 019 added (composite_sha256, png_sha256, shadow_sha256, task_files.sha256) have their
-- foreign keys already; photo_cutouts.source_sha256 names a derived picture that is never stored and
-- stays unlinked (FILESTORE_DESIGN.md 2.4). The referencing indexes for ON DELETE RESTRICT are in 019.
--
-- Every statement can run twice: each constraint is dropped if it exists just before it is added.
BEGIN;

ALTER TABLE hawa.design_studio_candidates
  DROP CONSTRAINT IF EXISTS dsc_preview_blob_fk,
  DROP CONSTRAINT IF EXISTS dsc_art_blob_fk;
ALTER TABLE hawa.design_studio_candidates
  ADD CONSTRAINT dsc_preview_blob_fk FOREIGN KEY (preview_sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT dsc_art_blob_fk     FOREIGN KEY (art_sha256)     REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;

ALTER TABLE hawa.canva_design_plans DROP CONSTRAINT IF EXISTS canva_plan_source_blob_fk;
ALTER TABLE hawa.canva_design_plans
  ADD CONSTRAINT canva_plan_source_blob_fk FOREIGN KEY (source_sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;

ALTER TABLE hawa.canva_editable_sources DROP CONSTRAINT IF EXISTS canva_editable_blob_fk;
ALTER TABLE hawa.canva_editable_sources
  ADD CONSTRAINT canva_editable_blob_fk FOREIGN KEY (sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;

ALTER TABLE hawa.comparison_pairs
  DROP CONSTRAINT IF EXISTS comparison_hawa_blob_fk,
  DROP CONSTRAINT IF EXISTS comparison_designer_blob_fk;
ALTER TABLE hawa.comparison_pairs
  ADD CONSTRAINT comparison_hawa_blob_fk     FOREIGN KEY (hawa_sha256)     REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT comparison_designer_blob_fk FOREIGN KEY (designer_sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;

ALTER TABLE hawa.design_studio_candidates VALIDATE CONSTRAINT dsc_preview_blob_fk;
ALTER TABLE hawa.design_studio_candidates VALIDATE CONSTRAINT dsc_art_blob_fk;
ALTER TABLE hawa.canva_design_plans       VALIDATE CONSTRAINT canva_plan_source_blob_fk;
ALTER TABLE hawa.canva_editable_sources   VALIDATE CONSTRAINT canva_editable_blob_fk;
ALTER TABLE hawa.comparison_pairs         VALIDATE CONSTRAINT comparison_hawa_blob_fk;
ALTER TABLE hawa.comparison_pairs         VALIDATE CONSTRAINT comparison_designer_blob_fk;

COMMIT;
