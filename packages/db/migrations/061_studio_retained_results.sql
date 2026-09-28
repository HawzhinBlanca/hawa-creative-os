-- ADR-111: immutable private result content, separate from operational call receipts.
BEGIN;
CREATE UNIQUE INDEX design_studio_calls_tenant_id_pair ON hawa.design_studio_calls(tenant_id,id);
CREATE TABLE hawa.design_studio_call_results (
  tenant_id uuid NOT NULL,
  call_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('structured','image')),
  payload_text text NOT NULL CHECK(jsonb_typeof(payload_text::jsonb)='object' AND octet_length(payload_text)<=4194304),
  payload_sha256 text NOT NULL CHECK(payload_sha256=encode(digest(payload_text,'sha256'),'hex')),
  image_sha256 text CHECK(image_sha256 ~ '^[0-9a-f]{64}$'),
  image_blob_sha256 text REFERENCES hawa.blobs(sha256),
  image_bytes bytea CHECK(octet_length(image_bytes)<=33554432),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,call_id) REFERENCES hawa.design_studio_calls(tenant_id,id),
  CHECK((kind='structured' AND image_sha256 IS NULL AND image_blob_sha256 IS NULL AND image_bytes IS NULL)
    OR (kind='image' AND image_sha256 IS NOT NULL AND
      ((image_blob_sha256 IS NOT NULL AND image_blob_sha256=image_sha256 AND image_bytes IS NULL) OR
       (image_blob_sha256 IS NULL AND image_bytes IS NOT NULL AND encode(digest(image_bytes,'sha256'),'hex')=image_sha256))))
);
ALTER TABLE hawa.design_studio_call_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.design_studio_call_results FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_results_scope ON hawa.design_studio_call_results USING (
 tenant_id=hawa.current_tenant_id() AND EXISTS (
  SELECT 1 FROM hawa.design_studio_calls c JOIN hawa.design_studio_runs r ON r.id=c.run_id AND r.tenant_id=c.tenant_id
  JOIN hawa.tasks t ON t.id=r.task_id AND t.tenant_id=r.tenant_id AND t.client_id=r.client_id
  WHERE c.id=call_id AND c.tenant_id=design_studio_call_results.tenant_id)
);
CREATE FUNCTION hawa.protect_studio_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Retained Studio result is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM hawa.design_studio_calls c WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.call_id AND c.status='ok' AND c.finished_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Retained Studio result needs a successful finalized call'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_result_immutable BEFORE INSERT OR UPDATE OR DELETE ON hawa.design_studio_call_results FOR EACH ROW EXECUTE FUNCTION hawa.protect_studio_result();
REVOKE ALL ON hawa.design_studio_call_results FROM PUBLIC,hawa_app;
GRANT SELECT,INSERT ON hawa.design_studio_call_results TO hawa_app;
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
  UNION ALL SELECT source_sha256 FROM hawa.client_documents
  UNION ALL SELECT payload->'blob'->>'sha256' FROM hawa.inbox_events
    WHERE source_account_id = 'lifecycle_source_upload' AND event_kind = 'lifecycle_source_upload'
      AND payload->'blob'->>'sha256' ~ '^[0-9a-f]{64}$'
  UNION ALL SELECT image_blob_sha256 FROM hawa.design_studio_call_results WHERE image_blob_sha256 IS NOT NULL;
COMMIT;
