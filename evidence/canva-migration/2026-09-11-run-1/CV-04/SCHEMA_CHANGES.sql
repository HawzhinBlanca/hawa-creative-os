-- Migration 001: Canva Native Studio Bindings & Artifact Capture Sets (ADR 020 / CV-04)
BEGIN;

CREATE SCHEMA IF NOT EXISTS hawa;
SET search_path = hawa, public;

CREATE TABLE IF NOT EXISTS canva_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  canva_design_id text NOT NULL,
  canva_team_id text,
  canva_user_id text,
  edit_url text NOT NULL,
  view_url text,
  direction_name text NOT NULL DEFAULT 'primary',
  status text NOT NULL DEFAULT 'bound' CHECK (status IN ('bound','unbound','revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, task_id, direction_name),
  UNIQUE (tenant_id, canva_design_id)
);

CREATE TABLE IF NOT EXISTS canva_capture_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES canva_bindings(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  parent_revision_id uuid REFERENCES design_revisions(id),
  captured_artifact_set_hash text NOT NULL CHECK (length(captured_artifact_set_hash)=64),
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts)='array'),
  export_settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(export_settings)='object'),
  semantic_coverage jsonb NOT NULL CHECK (jsonb_typeof(semantic_coverage)='object'),
  effect_job_id text,
  auth_actor jsonb NOT NULL CHECK (jsonb_typeof(auth_actor)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_canva_bindings_task ON canva_bindings(tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_canva_bindings_client ON canva_bindings(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_canva_bindings_design ON canva_bindings(canva_design_id);
CREATE INDEX IF NOT EXISTS idx_canva_capture_sets_binding ON canva_capture_sets(binding_id);
CREATE INDEX IF NOT EXISTS idx_canva_capture_sets_task ON canva_capture_sets(tenant_id, task_id);

COMMIT;
