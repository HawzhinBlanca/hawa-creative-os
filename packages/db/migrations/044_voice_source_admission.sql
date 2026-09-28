-- ADR-075: retained Ogg Opus and source-bound transcription admission. No model is admitted here.
BEGIN;
ALTER TABLE hawa.blobs DROP CONSTRAINT blobs_media_type_check;
ALTER TABLE hawa.blobs ADD CONSTRAINT blobs_media_type_check CHECK (media_type IN (
  'image/png','image/jpeg','image/webp','image/gif','application/pdf','audio/ogg',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'));
INSERT INTO hawa.model_roles(role,description,critical)
  VALUES ('voice_transcriber','Unreviewed voice source transcription with client privacy and bounded paid admission',true)
  ON CONFLICT DO NOTHING;
CREATE INDEX lifecycle_voice_daily_reservations ON hawa.inbox_events(tenant_id,(payload->>'day'))
  WHERE source_account_id='lifecycle_voice_attempt' AND event_kind='lifecycle_voice_attempt';
-- SELECT FOR SHARE also applies the model UPDATE RLS policy, which correctly excludes
-- the runtime operator. A narrow definer reader can lock an eligible deployment without
-- granting that operator permission to change any model or bypass client authorization.
CREATE FUNCTION hawa.lock_voice_deployments()
RETURNS TABLE(id uuid,deployment_version text,admission hawa.admission_state,policy_profile jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
BEGIN
  IF NOT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','model_evaluator']::hawa.membership_role[]) THEN
    RAISE EXCEPTION 'Voice model admission requires a tenant operator' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT m.id,m.deployment_version,m.admission,m.policy_profile FROM hawa.model_deployments m
    WHERE m.tenant_id=hawa.current_tenant_id() AND m.role='voice_transcriber' AND m.provider='openai'
      AND m.exact_model_id='whisper-1' AND m.admission IN ('canary','primary')
      AND m.valid_from<=now() AND (m.valid_until IS NULL OR m.valid_until>now())
    ORDER BY (m.admission='primary') DESC,m.valid_from DESC LIMIT 2 FOR SHARE OF m;
END $$;
REVOKE ALL ON FUNCTION hawa.lock_voice_deployments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lock_voice_deployments() TO hawa_app;
COMMIT;
