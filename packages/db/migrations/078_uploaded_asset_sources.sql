-- ADR218: immutable uploaded sources and verified admitted asset bytes.
BEGIN;
ALTER TABLE hawa.blobs DROP CONSTRAINT blobs_media_type_check;
ALTER TABLE hawa.blobs ADD CONSTRAINT blobs_media_type_check CHECK (media_type IN (
 'image/png','image/jpeg','image/webp','image/gif','image/svg+xml','font/ttf','font/otf','font/woff2',
 'application/pdf','audio/ogg','application/vnd.openxmlformats-officedocument.presentationml.presentation'));
ALTER TABLE hawa.brand_assets ADD COLUMN blob_sha256 text REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT;
ALTER TABLE hawa.brand_assets ADD CONSTRAINT brand_assets_blob_hash CHECK (blob_sha256 IS NULL OR blob_sha256=sha256);
ALTER TABLE hawa.brand_assets ADD CONSTRAINT brand_assets_tenant_client_id_key UNIQUE(tenant_id,client_id,id);
CREATE INDEX brand_assets_blob_sha_idx ON hawa.brand_assets(blob_sha256) WHERE blob_sha256 IS NOT NULL;
CREATE TABLE hawa.uploaded_asset_sources (
 tenant_id uuid NOT NULL,
 client_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 source_sha256 text NOT NULL REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT,
 filename text NOT NULL,
 uploaded_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,asset_id,source_sha256),
 FOREIGN KEY(tenant_id,client_id,asset_id) REFERENCES hawa.brand_assets(tenant_id,client_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,client_id) REFERENCES hawa.clients(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX uploaded_asset_source_sha_idx ON hawa.uploaded_asset_sources(source_sha256);
ALTER TABLE hawa.uploaded_asset_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.uploaded_asset_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY uploaded_asset_sources_read ON hawa.uploaded_asset_sources FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND (
   (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','auditor']::hawa.membership_role[]))
   OR client_id=ANY((SELECT hawa.member_client_ids(false))::uuid[]))
 AND EXISTS(SELECT 1 FROM hawa.brand_assets a WHERE a.tenant_id=uploaded_asset_sources.tenant_id
   AND a.id=asset_id AND a.client_id=uploaded_asset_sources.client_id));
CREATE POLICY uploaded_asset_sources_write ON hawa.uploaded_asset_sources FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND (
   (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))
   OR client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[]))
 AND EXISTS(SELECT 1 FROM hawa.brand_assets a WHERE a.tenant_id=uploaded_asset_sources.tenant_id
   AND a.id=asset_id AND a.client_id=uploaded_asset_sources.client_id));
REVOKE ALL ON hawa.uploaded_asset_sources FROM PUBLIC,hawa_app;
GRANT SELECT,INSERT ON hawa.uploaded_asset_sources TO hawa_app;
CREATE FUNCTION hawa.protect_uploaded_asset_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Uploaded asset sources are append-only' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION hawa.protect_uploaded_asset_source() FROM PUBLIC;
CREATE TRIGGER protect_uploaded_asset_source BEFORE UPDATE OR DELETE ON hawa.uploaded_asset_sources
 FOR EACH ROW EXECUTE FUNCTION hawa.protect_uploaded_asset_source();
CREATE OR REPLACE VIEW hawa.blob_references AS
  SELECT sha256 FROM hawa.task_files
  UNION ALL SELECT preview_sha256 FROM hawa.design_feedback WHERE preview_sha256 IS NOT NULL
  UNION ALL SELECT preview_sha256   FROM hawa.design_studio_candidates WHERE preview_sha256 IS NOT NULL
  UNION ALL SELECT composite_sha256 FROM hawa.design_studio_candidates WHERE composite_sha256 IS NOT NULL
  UNION ALL SELECT art_sha256       FROM hawa.design_studio_candidates WHERE art_sha256 IS NOT NULL
  UNION ALL SELECT source_sha256    FROM hawa.canva_design_plans WHERE source_sha256 IS NOT NULL
  UNION ALL SELECT sha256           FROM hawa.canva_editable_sources
  UNION ALL SELECT png_sha256       FROM hawa.photo_cutouts WHERE png_sha256 IS NOT NULL
  UNION ALL SELECT shadow_sha256    FROM hawa.photo_cutouts WHERE shadow_sha256 IS NOT NULL
  UNION ALL SELECT hawa_sha256      FROM hawa.comparison_pairs
  UNION ALL SELECT designer_sha256  FROM hawa.comparison_pairs
  UNION ALL SELECT payload->'draft'->'lifecycleImage'->>'sha256'
    FROM hawa.inbox_events
    WHERE source_account_id = 'lifecycle_chat_open'
      AND event_kind = 'lifecycle_new_brief_decision'
      AND payload->'draft'->'lifecycleImage'->>'sha256' ~ '^[0-9a-f]{64}$'
  UNION ALL SELECT payload->'image'->>'sha256'
    FROM hawa.inbox_events
    WHERE source_account_id = 'lifecycle_chat_revision_photo'
      AND event_kind = 'lifecycle_revision_photo_decision'
      AND payload->'image'->>'sha256' ~ '^[0-9a-f]{64}$'
  UNION ALL SELECT payload->'image'->>'sha256' FROM hawa.inbox_events
    WHERE source_account_id = 'lifecycle_album_part' AND event_kind = 'lifecycle_album_part'
      AND payload->'image'->>'sha256' ~ '^[0-9a-f]{64}$'
  UNION ALL SELECT source_sha256 FROM hawa.client_documents
  UNION ALL SELECT payload->'blob'->>'sha256' FROM hawa.inbox_events
    WHERE source_account_id = 'lifecycle_source_upload' AND event_kind = 'lifecycle_source_upload'
      AND payload->'blob'->>'sha256' ~ '^[0-9a-f]{64}$'
  UNION ALL SELECT image_blob_sha256 FROM hawa.design_studio_call_results WHERE image_blob_sha256 IS NOT NULL
  UNION ALL SELECT blob_sha256 FROM hawa.studio_visual_input_assets WHERE blob_sha256 IS NOT NULL
  UNION ALL SELECT blob_sha256 FROM hawa.brand_assets WHERE blob_sha256 IS NOT NULL
  UNION ALL SELECT source_sha256 FROM hawa.uploaded_asset_sources;
REVOKE ALL ON hawa.blob_references FROM PUBLIC,hawa_app;
COMMIT;
