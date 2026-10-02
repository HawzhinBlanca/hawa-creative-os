-- ADR261: immutable customer/client source receipts. No worker/customer raw blob authority.
BEGIN;
CREATE TABLE hawa.customer_photo_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 client_id uuid NOT NULL, subject uuid NOT NULL, action_key text NOT NULL,
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),
 sha256 text NOT NULL REFERENCES hawa.blobs(sha256),
 media_type text NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/webp')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 10485760),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 12000), height integer NOT NULL CHECK(height BETWEEN 1 AND 12000),
 CHECK(width::bigint*height<=24000000), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,action_key),
 FOREIGN KEY(tenant_id,account_id) REFERENCES hawa.customer_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES hawa.clients(tenant_id,id)
);
CREATE INDEX customer_photo_history ON hawa.customer_photo_receipts(tenant_id,account_id,created_at);
ALTER TABLE hawa.customer_photo_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_photo_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_photo_read ON hawa.customer_photo_receipts FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND
 ((hawa.current_customer_id() IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])))
 OR (account_id=hawa.current_customer_id() AND subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid
 AND client_id=ANY((SELECT hawa.customer_request_client_ids())::uuid[]))));
CREATE POLICY customer_photo_create ON hawa.customer_photo_receipts FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND account_id=hawa.current_customer_id()
 AND subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid
 AND client_id=ANY((SELECT hawa.customer_request_client_ids())::uuid[]));
CREATE TRIGGER customer_photo_immutable BEFORE UPDATE OR DELETE ON hawa.customer_photo_receipts
 FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
REVOKE ALL ON hawa.customer_photo_receipts FROM PUBLIC,hawa_worker;
GRANT SELECT,INSERT ON hawa.customer_photo_receipts TO hawa_app;
-- Rolling owner quota includes receipts for subsequently revoked brands.
CREATE FUNCTION hawa.customer_photo_usage() RETURNS TABLE(n bigint,bytes bigint)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF hawa.current_customer_id() IS NULL OR hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() THEN
  RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT count(*),COALESCE(sum(p.size),0)::bigint FROM hawa.customer_photo_receipts p
 WHERE p.tenant_id=hawa.current_tenant_id() AND p.account_id=hawa.current_customer_id() AND p.created_at>now()-interval '1 day';
END $$;
REVOKE ALL ON FUNCTION hawa.customer_photo_usage() FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_photo_usage() TO hawa_app;
-- Preserve all original GC roots plus owned unsubmitted originals.
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
  UNION ALL SELECT source_sha256 FROM hawa.uploaded_asset_sources
 UNION ALL SELECT sha256 FROM hawa.customer_photo_receipts;
REVOKE ALL ON hawa.blob_references FROM PUBLIC,hawa_app,hawa_worker;
COMMIT;
