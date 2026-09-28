-- ADR-076: a source hash identifies bytes, not a review checkpoint. A later
-- capture can retain identical PPTX bytes with a different preview, binding,
-- provider version or human decision. Preserve the byte hash and revision ledger.
BEGIN;
ALTER TABLE hawa.design_revisions
  DROP CONSTRAINT design_revisions_design_document_id_source_sha256_key;

-- Keep the historical deduplication rule for other studio contracts.
CREATE UNIQUE INDEX design_revisions_noncanva_source_unique
  ON hawa.design_revisions(design_document_id, source_sha256) WHERE studio <> 'canva';
CREATE INDEX design_revisions_canva_source_lookup
  ON hawa.design_revisions(design_document_id, source_sha256) WHERE studio = 'canva';
COMMIT;
