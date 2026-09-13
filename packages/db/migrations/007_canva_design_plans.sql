BEGIN;
CREATE TABLE hawa.canva_design_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  actor_id text NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('planning','planned','failed','uncertain')),
  result jsonb,
  source_content bytea,
  source_sha256 text,
  diagnostic text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,task_id,request_key),
  FOREIGN KEY(tenant_id,task_id,client_id) REFERENCES hawa.tasks(tenant_id,id,client_id),
  CHECK(source_content IS NULL OR source_sha256=encode(digest(source_content,'sha256'),'hex')),
  CHECK(status<>'planned' OR (result IS NOT NULL AND source_content IS NOT NULL AND source_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX canva_one_active_plan ON hawa.canva_design_plans(tenant_id,task_id) WHERE status IN ('planning','planned','uncertain');
ALTER TABLE hawa.canva_design_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.canva_design_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY canva_plan_scope ON hawa.canva_design_plans
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION hawa.protect_canva_plan_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Design planning evidence is append-only'; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.task_id,NEW.client_id,NEW.actor_id,NEW.request_key,NEW.request_hash,NEW.request)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.task_id,OLD.client_id,OLD.actor_id,OLD.request_key,OLD.request_hash,OLD.request)
    OR OLD.status IN ('planned','failed','uncertain') THEN RAISE EXCEPTION 'Design planning source or completed result is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_canva_plan BEFORE UPDATE OR DELETE ON hawa.canva_design_plans FOR EACH ROW EXECUTE FUNCTION hawa.protect_canva_plan_source();
GRANT SELECT,INSERT,UPDATE ON hawa.canva_design_plans TO hawa_app;
COMMIT;
