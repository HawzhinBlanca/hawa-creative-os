-- ADR-071: immutable local evidence, never approved knowledge.
BEGIN;
CREATE TABLE hawa.client_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  source_sha256 text NOT NULL REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT,
  extractor_version text NOT NULL,
  extraction_json text NOT NULL CHECK (octet_length(extraction_json) BETWEEN 1 AND 8388608),
  extraction_sha256 text NOT NULL CHECK (extraction_sha256 = encode(digest(extraction_json, 'sha256'), 'hex')),
  created_by uuid NOT NULL REFERENCES hawa.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((extraction_json::jsonb)->>'sourceSha256' = source_sha256),
  CHECK ((extraction_json::jsonb)->'extraction'->>'version' = extractor_version),
  UNIQUE (tenant_id,client_id,source_sha256,extractor_version),
  FOREIGN KEY (tenant_id,client_id) REFERENCES hawa.clients(tenant_id,id)
);
CREATE INDEX client_documents_recent ON hawa.client_documents(tenant_id,client_id,created_at DESC,id DESC);
ALTER TABLE hawa.client_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.client_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY client_documents_read ON hawa.client_documents FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM hawa.clients c WHERE c.tenant_id = client_documents.tenant_id AND c.id = client_documents.client_id));
CREATE POLICY client_documents_write ON hawa.client_documents FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND hawa.can_write_client(tenant_id,client_id));
CREATE TRIGGER client_documents_immutable BEFORE UPDATE OR DELETE ON hawa.client_documents
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
REVOKE ALL ON hawa.client_documents FROM PUBLIC, hawa_app;
GRANT SELECT, INSERT ON hawa.client_documents TO hawa_app;
CREATE OR REPLACE VIEW hawa.blob_references AS
  SELECT sha256 FROM hawa.task_files
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
  UNION ALL SELECT source_sha256 FROM hawa.client_documents;
REVOKE ALL ON hawa.blob_references FROM PUBLIC;
REVOKE ALL ON hawa.blob_references FROM hawa_app;

COMMIT;
