-- Retain the exact reviewed picture. Historical feedback remains explicitly unbound.
ALTER TABLE hawa.design_feedback ADD COLUMN preview_sha256 text
  CHECK (preview_sha256 IS NULL OR preview_sha256 ~ '^[a-f0-9]{64}$');
