-- Hawa Creative OS
-- PostgreSQL 18 + pgvector 0.8.x
-- Apply as a migration owner. Application roles must not own tables.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS hawa;
SET search_path = hawa, public;

CREATE TYPE membership_role AS ENUM (
  'requester','operator','designer','language_reviewer','approver',
  'client_dna_manager','model_evaluator','administrator','auditor'
);
CREATE TYPE task_state AS ENUM (
  'received','promotion_pending','routing','routing_review','brief_draft','brief_review',
  'context_ready','design_planning','asset_production','studio_composition','qa',
  'auto_repair','human_review','revision_requested','approved','publishing','complete',
  'paused','failed_retryable','failed_operator','cancelled','rejected'
);
CREATE TYPE record_status AS ENUM ('draft','active','inactive','superseded','deleted');
CREATE TYPE approval_decision AS ENUM ('approved','revision_requested','rejected','escalated');
CREATE TYPE admission_state AS ENUM ('candidate','shadow','canary','primary','fallback','retired','blocked');
CREATE TYPE evidence_polarity AS ENUM ('positive','negative','neutral');
CREATE TYPE feedback_scope AS ENUM ('one_time','task_type','project','client','office');
CREATE TYPE severity AS ENUM ('low','medium','high','critical');
CREATE TYPE publication_state AS ENUM ('pending','staging','drive_pending','drive_complete','sheet_pending','complete','failed','cancelled');
CREATE TYPE outbox_state AS ENUM ('pending','leased','delivered','failed','dead');
CREATE TYPE integration_health_state AS ENUM ('healthy','degraded','unavailable','disabled','reauth_required','unknown');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  slug citext NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'Asia/Baghdad',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  external_subject text UNIQUE,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role)
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code citext NOT NULL,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  default_language text NOT NULL DEFAULT 'en',
  retention_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(retention_policy)='object'),
  model_egress_policy jsonb NOT NULL DEFAULT '{"mode":"evaluated_external_allowed"}'::jsonb CHECK (jsonb_typeof(model_egress_policy)='object'),
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  code citext NOT NULL,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  status record_status NOT NULL DEFAULT 'active',
  due_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (client_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE client_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, user_id, role)
);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('telegram','waha','slack','email','google','hycanvas','comfyui','phoenix','model_provider','other')),
  name text NOT NULL,
  config_encrypted bytea,
  config_public jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE integration_health (
  integration_id uuid PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state integration_health_state NOT NULL DEFAULT 'unknown',
  cursor_value text,
  last_event_at timestamptz,
  last_success_at timestamptz,
  last_checked_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  external_account_id text NOT NULL,
  external_channel_id text NOT NULL,
  external_topic_id text NOT NULL DEFAULT '',
  client_id uuid,
  project_id uuid,
  allowed_client_ids uuid[] NOT NULL DEFAULT '{}',
  promotion_policy jsonb NOT NULL DEFAULT '{"mode":"explicit"}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  UNIQUE (integration_id, external_account_id, external_channel_id, external_topic_id, valid_from),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id),
  source_account_id text NOT NULL,
  source_event_id text NOT NULL,
  source_sequence text,
  event_kind text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  payload_hash text NOT NULL,
  verified boolean NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_error text,
  UNIQUE (integration_id, source_account_id, source_event_id)
);
-- One row per source event (migration 020): the constraint above never fires, because intake leaves
-- integration_id NULL. The outbox's send marks ('telegram_delivery') append a row per outcome and are
-- left out.
CREATE UNIQUE INDEX inbox_events_source_event_uidx
  ON inbox_events (tenant_id, integration_id, source_account_id, source_event_id) NULLS NOT DISTINCT
  WHERE source_account_id <> 'telegram_delivery';
-- Rows migration 020 moved out of inbox_events when it found them duplicated, with the row kept.
CREATE TABLE inbox_event_duplicates (
  LIKE inbox_events,
  kept_id uuid NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  removed_by text NOT NULL DEFAULT '020_inbox_event_dedupe.sql',
  PRIMARY KEY (id)
);

CREATE TABLE message_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inbox_event_id uuid REFERENCES inbox_events(id),
  integration_id uuid REFERENCES integrations(id),
  external_account_id text NOT NULL,
  external_channel_id text NOT NULL,
  external_thread_id text,
  external_message_id text NOT NULL,
  external_revision_id text NOT NULL DEFAULT '',
  sender_external_id text,
  mapped_user_id uuid REFERENCES users(id),
  language text,
  direction text CHECK (direction IN ('ltr','rtl','auto')),
  text_original text NOT NULL DEFAULT '',
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_payload_encrypted bytea,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  deleted_at_source timestamptz,
  UNIQUE (integration_id, external_account_id, external_channel_id, external_message_id, external_revision_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_event_id uuid NOT NULL,
  source_attachment_id text,
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL CHECK (length(sha256)=64),
  storage_key text NOT NULL,
  scan_state text NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending','clean','quarantined','rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, message_event_id) REFERENCES message_events(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (message_event_id, sha256)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid,
  project_id uuid,
  source_message_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  state task_state NOT NULL DEFAULT 'received',
  task_type text,
  language text,
  direction text CHECK (direction IN ('ltr','rtl','auto')),
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  sensitivity text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive','restricted')),
  requested_by uuid REFERENCES users(id),
  assigned_to uuid REFERENCES users(id),
  due_at timestamptz,
  current_brief_id uuid,
  current_plan_id uuid,
  current_design_revision_id uuid,
  workflow_id text UNIQUE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, source_message_id) REFERENCES message_events(tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  actor_type text NOT NULL CHECK (actor_type IN ('user','model','workflow','adapter','system')),
  actor_id text,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  trace_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, aggregate_version)
);

CREATE TABLE client_dna_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status record_status NOT NULL DEFAULT 'draft',
  dna jsonb NOT NULL CHECK (jsonb_typeof(dna)='object'),
  content_hash text NOT NULL,
  effective_from timestamptz,
  effective_until timestamptz,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (client_id, version),
  UNIQUE (client_id, content_hash),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from)
);
CREATE UNIQUE INDEX one_active_dna_per_client ON client_dna_versions(client_id) WHERE status='active';

CREATE TABLE client_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  dna_version_id uuid REFERENCES client_dna_versions(id),
  rule_key text NOT NULL,
  category text NOT NULL,
  scope feedback_scope NOT NULL,
  machine_rule jsonb NOT NULL CHECK (jsonb_typeof(machine_rule)='object'),
  human_rule text NOT NULL,
  status record_status NOT NULL DEFAULT 'draft',
  priority integer NOT NULL DEFAULT 100,
  effective_from timestamptz,
  effective_until timestamptz,
  supersedes_rule_id uuid REFERENCES client_rules(id),
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  UNIQUE (client_id, rule_key, created_at)
);

CREATE TABLE glossary_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  language text NOT NULL,
  term_original text NOT NULL,
  preferred text,
  prohibited boolean NOT NULL DEFAULT false,
  search_aliases text[] NOT NULL DEFAULT '{}',
  notes text,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  UNIQUE (client_id, project_id, language, term_original)
);

CREATE TABLE brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  kind text NOT NULL,
  name text NOT NULL,
  variant text,
  mime_type text NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256)=64),
  storage_key text,
  drive_file_id text,
  status record_status NOT NULL DEFAULT 'active',
  usage_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  UNIQUE (client_id, sha256)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  name text NOT NULL,
  task_type text NOT NULL,
  language text,
  studio text NOT NULL,
  studio_version text NOT NULL,
  source_storage_key text NOT NULL,
  source_sha256 text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  version integer NOT NULL CHECK (version > 0),
  status record_status NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  UNIQUE (client_id, name, version)
);

CREATE TABLE visual_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  task_id uuid,
  design_revision_id uuid,
  polarity evidence_polarity NOT NULL,
  task_type text,
  language text,
  tags text[] NOT NULL DEFAULT '{}',
  reason text,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id)
);

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL DEFAULT '',
  filename text,
  mime_type text,
  sha256 text NOT NULL,
  language text,
  status record_status NOT NULL DEFAULT 'active',
  parser text,
  parser_version text,
  parsed_storage_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  UNIQUE (client_id, source_kind, source_id, source_version, sha256),
  UNIQUE (tenant_id, id)
);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  document_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content_original text NOT NULL DEFAULT '',
  content_search text NOT NULL DEFAULT '',
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content_search)) STORED,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(2048),
  embedding_model text,
  embedding_version text,
  embedding_normalized boolean,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES knowledge_documents(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX knowledge_chunks_filter_idx ON knowledge_chunks(tenant_id, client_id, project_id, status);
CREATE INDEX knowledge_chunks_fts_idx ON knowledge_chunks USING gin(search_vector);
CREATE INDEX knowledge_chunks_trgm_idx ON knowledge_chunks USING gin(content_search gin_trgm_ops);
-- Add an HNSW index only after filtered exact search is measured insufficient.
-- CREATE INDEX knowledge_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE model_roles (
  role text PRIMARY KEY,
  description text NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL REFERENCES model_roles(role),
  version text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  tool_schema_hash text,
  response_schema_hash text,
  status record_status NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, role, version),
  UNIQUE (tenant_id, role, content_hash)
);

CREATE TABLE model_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL REFERENCES model_roles(role),
  provider text NOT NULL,
  exact_model_id text NOT NULL,
  endpoint_name text,
  deployment_version text NOT NULL,
  parameter_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  capability_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  admission admission_state NOT NULL DEFAULT 'candidate',
  evaluation_run_id uuid,
  fallback_rank integer,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, role, provider, exact_model_id, deployment_version),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX one_primary_model_per_scope_role ON model_deployments(COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid), role) WHERE admission='primary';

CREATE TABLE model_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid,
  project_id uuid,
  task_id uuid,
  deployment_id uuid NOT NULL REFERENCES model_deployments(id),
  prompt_version_id uuid REFERENCES prompt_versions(id),
  role text NOT NULL REFERENCES model_roles(role),
  request_hash text NOT NULL,
  input_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_hash text,
  output_manifest jsonb,
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','cancelled','blocked')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  tokens_input bigint,
  tokens_output bigint,
  asset_units numeric,
  cost_estimate numeric(18,6),
  latency_ms bigint,
  error_class text,
  error_detail text,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  UNIQUE (tenant_id, request_hash, deployment_id, attempt)
);

CREATE TABLE design_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief)='object'),
  content_hash text NOT NULL,
  status record_status NOT NULL DEFAULT 'draft',
  created_by_type text NOT NULL CHECK (created_by_type IN ('user','model','workflow')),
  created_by_id text,
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, version),
  UNIQUE (task_id, content_hash),
  UNIQUE (tenant_id, id)
);

CREATE TABLE design_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  content_hash text NOT NULL,
  created_by_invocation_id uuid REFERENCES model_invocations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brief_id) REFERENCES design_briefs(tenant_id, id),
  UNIQUE (task_id, version),
  UNIQUE (task_id, content_hash),
  UNIQUE (tenant_id, id)
);

CREATE TABLE design_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  direction_name text NOT NULL DEFAULT 'primary',
  studio text NOT NULL,
  studio_document_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, direction_name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE design_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  design_document_id uuid NOT NULL,
  parent_revision_id uuid REFERENCES design_revisions(id),
  revision integer NOT NULL CHECK (revision > 0),
  studio text NOT NULL,
  studio_version text NOT NULL,
  studio_schema_version text NOT NULL,
  source_storage_key text NOT NULL,
  source_sha256 text NOT NULL CHECK (length(source_sha256)=64),
  neutral_manifest jsonb NOT NULL CHECK (jsonb_typeof(neutral_manifest)='object'),
  neutral_manifest_sha256 text NOT NULL CHECK (length(neutral_manifest_sha256)=64),
  semantic_hash text NOT NULL,
  preview_sha256 text,
  author_type text NOT NULL CHECK (author_type IN ('user','model','workflow','import')),
  author_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','rejected','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_document_id) REFERENCES design_documents(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (design_document_id, revision),
  UNIQUE (design_document_id, source_sha256),
  UNIQUE (tenant_id, id)
);

CREATE TABLE design_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  design_revision_id uuid NOT NULL,
  operation_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  expected_source_sha256 text NOT NULL,
  operation jsonb NOT NULL CHECK (jsonb_typeof(operation)='object'),
  result jsonb,
  status text NOT NULL CHECK (status IN ('applied','rejected','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (design_revision_id, operation_id)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  design_revision_id uuid NOT NULL,
  kind text NOT NULL,
  variant text NOT NULL DEFAULT 'default',
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL CHECK (length(sha256)=64),
  width integer,
  height integer,
  storage_key text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (design_revision_id, kind, variant, sha256),
  UNIQUE (tenant_id, id)
);

CREATE TABLE qc_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text NOT NULL,
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules)='object'),
  content_hash text NOT NULL,
  status record_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE qc_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  design_revision_id uuid NOT NULL,
  qc_profile_id uuid NOT NULL REFERENCES qc_profiles(id),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('running','passed','failed','error','cancelled')),
  critical_pass boolean,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_sha256 text,
  trace_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (design_revision_id, qc_profile_id, attempt),
  UNIQUE (tenant_id, id)
);

CREATE TABLE qc_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qc_run_id uuid NOT NULL,
  rule_id text NOT NULL,
  severity severity NOT NULL,
  hard_failure boolean NOT NULL,
  category text NOT NULL,
  message text NOT NULL,
  node_ids text[] NOT NULL DEFAULT '{}',
  region jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  repair jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, qc_run_id) REFERENCES qc_runs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  design_revision_id uuid NOT NULL,
  qc_run_id uuid,
  stage text NOT NULL,
  assigned_user_id uuid REFERENCES users(id),
  assigned_role membership_role,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided','expired','cancelled','superseded')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id),
  FOREIGN KEY (tenant_id, qc_run_id) REFERENCES qc_runs(tenant_id, id),
  CHECK (assigned_user_id IS NOT NULL OR assigned_role IS NOT NULL)
);
CREATE UNIQUE INDEX review_requests_unique_assignment ON review_requests(
  task_id, design_revision_id, stage,
  COALESCE(assigned_user_id,'00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(assigned_role,'requester'::membership_role)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  review_request_id uuid NOT NULL REFERENCES review_requests(id),
  design_revision_id uuid NOT NULL,
  qc_run_id uuid,
  decision approval_decision NOT NULL,
  decided_by uuid NOT NULL REFERENCES users(id),
  reason text,
  decision_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_approved_requires_qc CHECK (decision <> 'approved' OR qc_run_id IS NOT NULL),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id),
  FOREIGN KEY (tenant_id, qc_run_id) REFERENCES qc_runs(tenant_id, id),
  UNIQUE (review_request_id, nonce)
);

CREATE TABLE feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  task_id uuid,
  before_revision_id uuid,
  after_revision_id uuid,
  category text NOT NULL,
  severity severity NOT NULL DEFAULT 'medium',
  scope feedback_scope NOT NULL DEFAULT 'one_time',
  explicitness text NOT NULL CHECK (explicitness IN ('direct_instruction','manual_edit','approval_signal','inferred_pattern')),
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_value jsonb,
  corrected_value jsonb,
  comment text,
  actor_id uuid REFERENCES users(id),
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, before_revision_id) REFERENCES design_revisions(tenant_id, id),
  FOREIGN KEY (tenant_id, after_revision_id) REFERENCES design_revisions(tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE rule_evidence (
  rule_id uuid NOT NULL REFERENCES client_rules(id) ON DELETE CASCADE,
  feedback_event_id uuid REFERENCES feedback_events(id),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  weight numeric NOT NULL DEFAULT 1,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, source_kind, source_id)
);

CREATE TABLE eval_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text NOT NULL,
  role text,
  description text NOT NULL,
  content_hash text NOT NULL,
  frozen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id) ON DELETE CASCADE,
  case_key text NOT NULL,
  language text,
  input jsonb NOT NULL,
  expected jsonb,
  rubric jsonb NOT NULL DEFAULT '{}'::jsonb,
  holdout boolean NOT NULL DEFAULT false,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, case_key)
);

CREATE TABLE eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  candidate jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  eval_case_id uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  output jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('passed','failed','error','pending_review')),
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (eval_run_id, eval_case_id)
);
ALTER TABLE model_deployments ADD CONSTRAINT model_deployment_eval_fk FOREIGN KEY (evaluation_run_id) REFERENCES eval_runs(id);

CREATE TABLE publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  design_revision_id uuid NOT NULL,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  publication_key text NOT NULL,
  state publication_state NOT NULL DEFAULT 'pending',
  package_manifest jsonb NOT NULL CHECK (jsonb_typeof(package_manifest)='object'),
  package_sha256 text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  error_class text,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id),
  UNIQUE (tenant_id, publication_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX publications_tenant_task_created_idx
  ON publications (tenant_id, task_id, created_at DESC);

-- ADR-044: a provider-generated ID is committed before any file upload.
CREATE TABLE drive_upload_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  publication_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  task_id uuid NOT NULL,
  package_sha256 text NOT NULL,
  folder_id text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  expected_sha256 text NOT NULL,
  drive_file_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, publication_id) REFERENCES publications(tenant_id, id),
  UNIQUE (publication_id, artifact_id),
  UNIQUE (drive_file_id)
);

CREATE TABLE drive_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL,
  artifact_id uuid,
  shared_drive_id text NOT NULL,
  folder_id text NOT NULL,
  file_id text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  expected_sha256 text,
  observed_size bigint,
  permission_digest text,
  verified_at timestamptz,
  status text NOT NULL CHECK (status IN ('uploaded','verified','missing','mismatch','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, publication_id) REFERENCES publications(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts(tenant_id, id),
  UNIQUE (publication_id, file_id)
);

CREATE TABLE sheet_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL,
  spreadsheet_id text NOT NULL,
  sheet_id bigint NOT NULL,
  task_id uuid NOT NULL,
  row_key text NOT NULL,
  row_number bigint,
  expected_hash text NOT NULL,
  observed_hash text,
  status text NOT NULL CHECK (status IN ('pending','synced','stale','missing','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, publication_id) REFERENCES publications(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  UNIQUE (spreadsheet_id, sheet_id, row_key)
);

CREATE TABLE outbox_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  command_type text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  state outbox_state NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX outbox_dispatch_idx ON outbox_commands(state, available_at) WHERE state IN ('pending','failed');

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  client_id uuid,
  task_id uuid,
  reason text,
  before_hash text,
  after_hash text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id)
);

CREATE TABLE backup_drills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  target_timestamp timestamptz,
  rpo_seconds bigint,
  rto_seconds bigint,
  status text NOT NULL CHECK (status IN ('running','passed','failed')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_by uuid REFERENCES users(id)
);

-- Current projection foreign keys added after dependent tables exist.
ALTER TABLE tasks ADD CONSTRAINT tasks_current_brief_fk FOREIGN KEY (tenant_id, current_brief_id) REFERENCES design_briefs(tenant_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_current_plan_fk FOREIGN KEY (tenant_id, current_plan_id) REFERENCES design_plans(tenant_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_current_revision_fk FOREIGN KEY (tenant_id, current_design_revision_id) REFERENCES design_revisions(tenant_id, id);
ALTER TABLE visual_examples ADD CONSTRAINT visual_examples_revision_fk FOREIGN KEY (tenant_id, design_revision_id) REFERENCES design_revisions(tenant_id, id);

-- Common indexes.
CREATE INDEX clients_tenant_status_idx ON clients(tenant_id, status);
CREATE INDEX projects_client_status_idx ON projects(client_id, status);
CREATE INDEX messages_channel_time_idx ON message_events(integration_id, external_channel_id, occurred_at DESC);
CREATE INDEX tasks_inbox_idx ON tasks(tenant_id, state, priority, due_at NULLS LAST, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tasks_client_history_idx ON tasks(client_id, project_id, created_at DESC);
CREATE INDEX task_events_timeline_idx ON task_events(task_id, aggregate_version);
CREATE INDEX rules_active_idx ON client_rules(client_id, project_id, category, priority) WHERE status='active';
CREATE INDEX assets_active_idx ON brand_assets(client_id, project_id, kind) WHERE status='active';
CREATE INDEX examples_lookup_idx ON visual_examples(client_id, project_id, task_type, language, polarity) WHERE status='active';
CREATE INDEX model_invocations_task_idx ON model_invocations(task_id, created_at DESC);
CREATE INDEX design_revisions_task_idx ON design_revisions(task_id, created_at DESC);
CREATE INDEX qc_runs_revision_idx ON qc_runs(design_revision_id, started_at DESC);
-- The Desk's task list (migration 018): keyset pages, and each row's latest QC run and approval.
CREATE INDEX tasks_list_idx ON tasks(tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX qc_runs_task_idx ON qc_runs(task_id, started_at DESC);
CREATE INDEX approvals_task_idx ON approvals(task_id, created_at DESC);
CREATE INDEX feedback_client_idx ON feedback_events(client_id, project_id, category, created_at DESC);
CREATE INDEX audit_time_idx ON audit_events(tenant_id, occurred_at DESC);

-- updated_at triggers.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','clients','projects','integrations','integration_health','brand_assets','model_deployments','tasks','publications','sheet_syncs']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON hawa.%I FOR EACH ROW EXECUTE FUNCTION hawa.set_updated_at()', t, t);
  END LOOP;
END $$;

-- Append-only guards. Redaction/purge must use privileged migration procedures.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_events','design_operations','approvals','feedback_events','rule_evidence','audit_events']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON hawa.%I FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete()', t, t);
  END LOOP;
END $$;

-- The file store (ADR-035): hawa.blobs, hawa.task_files, the blob_references view and the garbage
-- collector's functions are created by packages/db/migrations/019_blob_store.sql, not here: they refer
-- to tables that only the versioned migrations create (design_studio_candidates, canva_design_plans,
-- photo_cutouts, comparison_pairs). Every database gets them through the upgrade runner.

-- Figma Agent Studio v2.0 tables
CREATE TABLE IF NOT EXISTS design_jobs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id text NOT NULL,
  client_id text NOT NULL,
  route text NOT NULL CHECK (route IN ('buzz_template','figma_freeform','human')),
  figma_file_key text,
  figma_node_id text,
  template_id text,
  revision integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS figma_leases (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id text NOT NULL,
  client_id text NOT NULL,
  figma_file_key text NOT NULL,
  holder text NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_task_lease ON figma_leases(task_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS figma_mutations (
  id bigserial PRIMARY KEY,
  design_job_id text NOT NULL,
  command_id text NOT NULL UNIQUE,
  expected_revision integer NOT NULL,
  resulting_revision integer,
  operation text NOT NULL,
  args_hash text NOT NULL,
  affected_node_ids jsonb,
  marker_id text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
