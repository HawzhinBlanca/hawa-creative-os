-- ADR-121: the existing operation ledger owns one admitted native copy attempt.
BEGIN;
CREATE OR REPLACE FUNCTION hawa.preserve_native_copy_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.metadata->>'method'='native_text_copy' OR NEW.metadata->>'method'='native_text_copy' THEN
  IF ROW(OLD.id,OLD.tenant_id,OLD.task_id,OLD.client_id,OLD.actor_id,OLD.request_key,OLD.request_hash,OLD.kind)
     IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.task_id,NEW.client_id,NEW.actor_id,NEW.request_key,NEW.request_hash,NEW.kind)
     OR OLD.metadata->>'method' IS DISTINCT FROM NEW.metadata->>'method'
     OR OLD.metadata->'nativeTextCopy' IS DISTINCT FROM NEW.metadata->'nativeTextCopy'
     OR (OLD.remote_job_id IS NOT NULL AND OLD.remote_job_id IS DISTINCT FROM NEW.remote_job_id)
     OR (OLD.design_id IS NOT NULL AND OLD.design_id IS DISTINCT FROM NEW.design_id)
     OR (OLD.status='retrieved' AND NEW.status<>'retrieved')
  THEN RAISE EXCEPTION 'Native copy claim and acquired identities are immutable' USING ERRCODE='23514'; END IF;
  IF NEW.status='retrieved' AND (NEW.remote_job_id IS NULL OR NEW.design_id IS NULL OR
      NEW.design_id=NEW.metadata->'nativeTextCopy'->'basis'->>'sourceDesignId')
  THEN RAISE EXCEPTION 'Native copy completion requires a separate design and job' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS preserve_native_copy_claim ON hawa.canva_remote_operations;
CREATE TRIGGER preserve_native_copy_claim BEFORE UPDATE ON hawa.canva_remote_operations
 FOR EACH ROW EXECUTE FUNCTION hawa.preserve_native_copy_claim();
COMMIT;
