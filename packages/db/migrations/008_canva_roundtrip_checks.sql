BEGIN;
ALTER TABLE hawa.canva_export_bytes DROP CONSTRAINT canva_export_bytes_format_check;
ALTER TABLE hawa.canva_export_bytes ADD CONSTRAINT canva_export_bytes_format_check CHECK(format IN ('png','pdf_standard','pptx'));
ALTER TABLE hawa.canva_export_bytes ADD COLUMN content_check jsonb;
COMMIT;
