BEGIN;
CREATE TABLE IF NOT EXISTS hawa.canva_connections (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  actor_id text NOT NULL,
  encrypted_tokens text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','refreshing','reconnect_required')),
  generation uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id)
);
CREATE TABLE IF NOT EXISTS hawa.canva_oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  actor_id text NOT NULL,
  encrypted_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hawa.canva_remote_operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  actor_id text NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export','create')),
  status text NOT NULL CHECK (status IN ('creating','submitted','retrieved','uncertain','failed','stale')),
  design_id text,
  binding_version integer,
  remote_job_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id, request_key),
  UNIQUE (tenant_id, task_id, client_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES hawa.tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES hawa.clients(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS hawa.canva_export_bytes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('png','pdf_standard')),
  sha256 text NOT NULL,
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 32 AND 26214400),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id),
  CHECK (sha256 = encode(digest(content, 'sha256'), 'hex')),
  FOREIGN KEY (tenant_id, task_id, client_id, operation_id)
    REFERENCES hawa.canva_remote_operations(tenant_id, task_id, client_id, id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['canva_connections','canva_oauth_states','canva_remote_operations','canva_export_bytes'] LOOP
    EXECUTE format('ALTER TABLE hawa.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hawa.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS canva_tenant_scope ON hawa.%I',t);
    EXECUTE format('CREATE POLICY canva_tenant_scope ON hawa.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS canva_export_bytes_immutable ON hawa.canva_export_bytes;
CREATE TRIGGER canva_export_bytes_immutable BEFORE UPDATE OR DELETE ON hawa.canva_export_bytes
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
COMMIT;
