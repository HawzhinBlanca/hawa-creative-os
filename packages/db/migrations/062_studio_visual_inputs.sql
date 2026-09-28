-- ADR-112: one immutable visual basis per run; exact bytes survive later derivations.
BEGIN;
CREATE UNIQUE INDEX design_studio_runs_tenant_id_pair ON hawa.design_studio_runs(tenant_id,id);
CREATE TABLE hawa.studio_visual_inputs (
 tenant_id uuid NOT NULL,
 run_id uuid PRIMARY KEY,
 manifest_text text NOT NULL CHECK(jsonb_typeof(manifest_text::jsonb)='object' AND octet_length(manifest_text)<=1048576),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256=encode(digest(manifest_text,'sha256'),'hex')),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES hawa.design_studio_runs(tenant_id,id)
);
CREATE TABLE hawa.studio_visual_input_assets (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 asset_key text NOT NULL CHECK(length(asset_key) BETWEEN 1 AND 80),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 blob_sha256 text REFERENCES hawa.blobs(sha256),
 bytes bytea,
 PRIMARY KEY(run_id,asset_key),
 FOREIGN KEY(tenant_id,run_id) REFERENCES hawa.studio_visual_inputs(tenant_id,run_id),
 CHECK((blob_sha256 IS NOT NULL AND blob_sha256=sha256 AND bytes IS NULL) OR
  (blob_sha256 IS NULL AND bytes IS NOT NULL AND octet_length(bytes) BETWEEN 1 AND 33554432 AND encode(digest(bytes,'sha256'),'hex')=sha256))
);
ALTER TABLE hawa.studio_visual_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.studio_visual_inputs FORCE ROW LEVEL SECURITY;
ALTER TABLE hawa.studio_visual_input_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.studio_visual_input_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_visual_inputs_scope ON hawa.studio_visual_inputs USING (
 tenant_id=hawa.current_tenant_id() AND EXISTS (
  SELECT 1 FROM hawa.design_studio_runs r JOIN hawa.tasks t ON t.id=r.task_id AND t.tenant_id=r.tenant_id AND t.client_id=r.client_id
  WHERE r.id=run_id AND r.tenant_id=studio_visual_inputs.tenant_id)
);
CREATE POLICY studio_visual_assets_scope ON hawa.studio_visual_input_assets USING (
 tenant_id=hawa.current_tenant_id() AND EXISTS (
  SELECT 1 FROM hawa.studio_visual_inputs b WHERE b.run_id=studio_visual_input_assets.run_id AND b.tenant_id=studio_visual_input_assets.tenant_id)
);
CREATE FUNCTION hawa.protect_studio_visual_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Studio visual inputs are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_visual_inputs_immutable BEFORE UPDATE OR DELETE ON hawa.studio_visual_inputs FOR EACH ROW EXECUTE FUNCTION hawa.protect_studio_visual_inputs();
CREATE TRIGGER studio_visual_assets_immutable BEFORE UPDATE OR DELETE ON hawa.studio_visual_input_assets FOR EACH ROW EXECUTE FUNCTION hawa.protect_studio_visual_inputs();
CREATE FUNCTION hawa.check_studio_visual_asset_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hawa.studio_visual_inputs b WHERE b.run_id=NEW.run_id AND b.tenant_id=NEW.tenant_id AND b.creation_xid=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Studio visual assets must commit with their immutable manifest'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studio_visual_assets_insert BEFORE INSERT ON hawa.studio_visual_input_assets FOR EACH ROW EXECUTE FUNCTION hawa.check_studio_visual_asset_insert();
REVOKE ALL ON hawa.studio_visual_inputs,hawa.studio_visual_input_assets FROM PUBLIC,hawa_app;
GRANT SELECT,INSERT ON hawa.studio_visual_inputs,hawa.studio_visual_input_assets TO hawa_app;
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
  UNION ALL SELECT image_blob_sha256 FROM hawa.design_studio_call_results WHERE image_blob_sha256 IS NOT NULL
  UNION ALL SELECT blob_sha256 FROM hawa.studio_visual_input_assets WHERE blob_sha256 IS NOT NULL;
COMMIT;
