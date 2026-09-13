BEGIN;
CREATE TABLE hawa.canva_editable_sources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  actor_id text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  sha256 text NOT NULL,
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 32 AND 26214400),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sha256 = encode(digest(content, 'sha256'), 'hex')),
  FOREIGN KEY (tenant_id,task_id,client_id,operation_id)
    REFERENCES hawa.canva_remote_operations(tenant_id,task_id,client_id,id)
);
ALTER TABLE hawa.canva_editable_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.canva_editable_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY canva_source_scope ON hawa.canva_editable_sources
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER canva_editable_sources_immutable BEFORE UPDATE OR DELETE ON hawa.canva_editable_sources
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
GRANT SELECT, INSERT ON hawa.canva_editable_sources TO hawa_app;
COMMIT;
