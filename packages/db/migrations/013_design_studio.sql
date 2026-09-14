BEGIN;

-- 1. Design Studio Runs
CREATE TABLE hawa.design_studio_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  actor_id text NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  tier text NOT NULL CHECK (tier IN ('standard', 'premium')),
  status text NOT NULL CHECK (status IN (
    'briefing', 'conceiving', 'laying_out', 'rendering', 'critiquing',
    'revising', 'judging', 'qa', 'awaiting_selection', 'transferring',
    'transferred', 'degraded', 'failed', 'abandoned'
  )),
  judge_status text CHECK (judge_status IS NULL OR judge_status IN ('PENDING', 'RELIABLE', 'UNRELIABLE', 'SKIPPED')),
  budget jsonb NOT NULL DEFAULT '{"maxUsd":6.00,"maxCalls":40,"spentUsd":0.00,"calls":0}'::jsonb,
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  winner_candidate_id uuid,
  plan_id uuid REFERENCES hawa.canva_design_plans(id),
  diagnostic text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, task_id, request_key),
  FOREIGN KEY(tenant_id, task_id, client_id) REFERENCES hawa.tasks(tenant_id, id, client_id)
);

CREATE UNIQUE INDEX design_studio_one_active_run
  ON hawa.design_studio_runs(tenant_id, task_id)
  WHERE status NOT IN ('transferred', 'degraded', 'failed', 'abandoned');

ALTER TABLE hawa.design_studio_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.design_studio_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY design_studio_runs_tenant_scope ON hawa.design_studio_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Design Studio Candidates
CREATE TABLE hawa.design_studio_candidates (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  ordinal int NOT NULL,
  concept jsonb NOT NULL,
  layouts jsonb[] NOT NULL DEFAULT '{}',
  metrics jsonb,
  critiques jsonb[] NOT NULL DEFAULT '{}',
  score numeric,
  rank int,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'eliminated', 'winner', 'runner_up')),
  preview_png bytea,
  preview_sha256 text,
  composite_png bytea,
  art_png bytea,
  art_sha256 text,
  art_provenance jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, ordinal),
  CHECK(preview_png IS NULL OR preview_sha256 = encode(digest(preview_png, 'sha256'), 'hex')),
  CHECK(art_png IS NULL OR art_sha256 = encode(digest(art_png, 'sha256'), 'hex'))
);

ALTER TABLE hawa.design_studio_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.design_studio_candidates FORCE ROW LEVEL SECURITY;

CREATE POLICY design_studio_candidates_tenant_scope ON hawa.design_studio_candidates
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Design Studio Judgments
CREATE TABLE hawa.design_studio_judgments (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('critique', 'pairwise', 'canary', 'parity', 'art_check')),
  candidate_a uuid REFERENCES hawa.design_studio_candidates(id),
  candidate_b uuid REFERENCES hawa.design_studio_candidates(id),
  order_swapped boolean NOT NULL DEFAULT false,
  verdict jsonb NOT NULL,
  call_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hawa.design_studio_judgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.design_studio_judgments FORCE ROW LEVEL SECURITY;

CREATE POLICY design_studio_judgments_tenant_scope ON hawa.design_studio_judgments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 4. Design Studio Calls (Financial Ledger)
CREATE TABLE hawa.design_studio_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  stage text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  requested_model text NOT NULL,
  response_id text,
  input_tokens int NOT NULL DEFAULT 0,
  cached_input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  images int NOT NULL DEFAULT 0,
  usd_estimate numeric NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ok', 'error', 'uncertain')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE hawa.design_studio_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.design_studio_calls FORCE ROW LEVEL SECURITY;

CREATE POLICY design_studio_calls_tenant_scope ON hawa.design_studio_calls
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 5. Design Feedback
CREATE TABLE hawa.design_feedback (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid REFERENCES hawa.design_studio_runs(id),
  candidate_id uuid REFERENCES hawa.design_studio_candidates(id),
  actor_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('desk', 'telegram', 'import')),
  verdict text NOT NULL CHECK (verdict IN ('approve', 'reject', 'revise', 'rating')),
  rating int CHECK (rating IS NULL OR (rating >= 1 AND rating <= 10)),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hawa.design_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.design_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY design_feedback_tenant_scope ON hawa.design_feedback
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Immutability Protection Trigger on Runs
CREATE OR REPLACE FUNCTION hawa.protect_design_studio_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Design studio runs are append-only';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.task_id, NEW.client_id, NEW.actor_id, NEW.request_key, NEW.request_hash)
    IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.task_id, OLD.client_id, OLD.actor_id, OLD.request_key, OLD.request_hash) THEN
    RAISE EXCEPTION 'Design studio run core identification is immutable';
  END IF;
  IF OLD.status IN ('transferred', 'degraded', 'failed', 'abandoned') THEN
    RAISE EXCEPTION 'Completed design studio run is immutable (status: %)', OLD.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER immutable_design_studio_run
  BEFORE UPDATE OR DELETE ON hawa.design_studio_runs
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_design_studio_run();

-- Immutability Protection Trigger on Calls Ledger
CREATE OR REPLACE FUNCTION hawa.protect_design_studio_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Design studio calls ledger is append-only';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('ok', 'error') THEN
    RAISE EXCEPTION 'Completed design studio call is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER immutable_design_studio_call
  BEFORE UPDATE OR DELETE ON hawa.design_studio_calls
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_design_studio_call();

-- Runtime Grants for Application Role
GRANT SELECT, INSERT, UPDATE ON hawa.design_studio_runs TO hawa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hawa.design_studio_candidates TO hawa_app;
GRANT SELECT, INSERT ON hawa.design_studio_judgments TO hawa_app;
GRANT SELECT, INSERT, UPDATE ON hawa.design_studio_calls TO hawa_app;
GRANT SELECT, INSERT ON hawa.design_feedback TO hawa_app;

COMMIT;
