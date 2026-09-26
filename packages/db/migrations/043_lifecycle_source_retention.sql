-- ADR-073: original request source remains rooted before extraction or confirmation.
BEGIN;
ALTER TABLE hawa.task_files DROP CONSTRAINT task_files_role_check;
ALTER TABLE hawa.task_files ADD CONSTRAINT task_files_role_check CHECK (role IN ('reference_image', 'source_document'));
-- Retain the original permissive tenant gate, adding mandatory client restrictions.
-- Even replay of migration 019 cannot OR a tenant-only policy past these restrictions.
CREATE POLICY task_files_client_read ON hawa.task_files AS RESTRICTIVE FOR SELECT USING (
  tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND
  EXISTS (SELECT 1 FROM hawa.tasks t WHERE t.tenant_id=task_files.tenant_id AND t.id=task_files.task_id)
);
CREATE POLICY task_files_client_write ON hawa.task_files AS RESTRICTIVE FOR INSERT WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND
  EXISTS (SELECT 1 FROM hawa.tasks t WHERE t.tenant_id=task_files.tenant_id AND t.id=task_files.task_id
    AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))
      OR t.client_id = ANY ((SELECT hawa.member_client_ids(true))::uuid[])))
);
CREATE INDEX lifecycle_source_reply ON hawa.inbox_events
  (tenant_id, (payload->>'chatId'), (payload->>'senderId'), (payload->>'topicId'), (payload->>'messageId'))
  WHERE source_account_id='lifecycle_source_upload' AND event_kind='lifecycle_source_upload';
CREATE INDEX lifecycle_source_confirmation_update ON hawa.inbox_events
  (tenant_id, (payload->>'confirmationUpdateId')) WHERE source_account_id='lifecycle_source_confirmation';
CREATE INDEX lifecycle_source_client ON hawa.inbox_events (tenant_id, (payload->>'clientId'), received_at DESC)
  WHERE source_account_id='lifecycle_source_upload' AND event_kind='lifecycle_source_upload';
CREATE INDEX lifecycle_source_open ON hawa.inbox_events
  (tenant_id, (payload->>'requestId')) WHERE source_account_id='lifecycle_chat_open'
    AND payload->'draft'->'lifecycleSource' IS NOT NULL;
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
      AND payload->'blob'->>'sha256' ~ '^[0-9a-f]{64}$';
REVOKE ALL ON hawa.blob_references FROM PUBLIC, hawa_app;
COMMIT;
