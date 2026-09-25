-- 023: durable Core projection for a Restate-owned request (ADR-034, Phase 2.3/2.8).
-- The request owner is set only when its first task is created. Legacy tasks retain NULL request_id.
-- Projection receipts bind a revision and an idempotency key to the exact input hash; no replay may
-- change the result or take ownership of a task that the legacy outbox has already claimed.
BEGIN;

CREATE TABLE IF NOT EXISTS hawa.requests (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  root_task_id uuid NOT NULL,
  current_task_id uuid NOT NULL,
  parent_request_id uuid,
  owner text NOT NULL CHECK (owner IN ('core','restate')),
  stage text NOT NULL CHECK (stage IN ('designing','awaiting_answer','in_review','manual','approved','delivering','delivered','expired','cancelled')),
  rev bigint NOT NULL CHECK (rev >= 1),
  chat_id text,
  draft_sent_at timestamptz,
  question_asked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id),
  UNIQUE (tenant_id, root_task_id),
  FOREIGN KEY (tenant_id, root_task_id) REFERENCES hawa.tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, current_task_id) REFERENCES hawa.tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_request_id) REFERENCES hawa.requests(tenant_id, request_id)
);

ALTER TABLE hawa.tasks ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE INDEX IF NOT EXISTS tasks_request_idx ON hawa.tasks(tenant_id, request_id) WHERE request_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_request_tenant_fk' AND conrelid = 'hawa.tasks'::regclass) THEN
    ALTER TABLE hawa.tasks ADD CONSTRAINT tasks_request_tenant_fk FOREIGN KEY (tenant_id, request_id)
      REFERENCES hawa.requests(tenant_id, request_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS hawa.lifecycle_projections (
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  rev bigint NOT NULL CHECK (rev >= 1),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id, rev),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, request_id) REFERENCES hawa.requests(tenant_id, request_id)
);

-- The task is the access boundary; membership checks are hoisted as in migration 016/021.
ALTER TABLE hawa.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS requests_task_select ON hawa.requests;
CREATE POLICY requests_task_select ON hawa.requests FOR SELECT USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.tasks tx WHERE tx.tenant_id = requests.tenant_id AND tx.id = requests.root_task_id
  )
);
DROP POLICY IF EXISTS requests_task_write ON hawa.requests;
CREATE POLICY requests_task_write ON hawa.requests FOR ALL USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.tasks tx WHERE tx.tenant_id = requests.tenant_id AND tx.id = requests.root_task_id
      AND (tx.client_id IS NULL OR (tx.tenant_id = hawa.current_tenant_id() AND (
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[]))
        OR tx.client_id = ANY ((SELECT hawa.member_client_ids(true))::uuid[])
      )))
  )
) WITH CHECK (tenant_id = hawa.current_tenant_id());

ALTER TABLE hawa.lifecycle_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.lifecycle_projections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lifecycle_projections_task_select ON hawa.lifecycle_projections;
CREATE POLICY lifecycle_projections_task_select ON hawa.lifecycle_projections FOR SELECT USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.requests r WHERE r.tenant_id = lifecycle_projections.tenant_id AND r.request_id = lifecycle_projections.request_id
  )
);
DROP POLICY IF EXISTS lifecycle_projections_task_write ON hawa.lifecycle_projections;
CREATE POLICY lifecycle_projections_task_write ON hawa.lifecycle_projections FOR INSERT WITH CHECK (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.requests r WHERE r.tenant_id = lifecycle_projections.tenant_id AND r.request_id = lifecycle_projections.request_id
  )
);

REVOKE ALL ON hawa.requests, hawa.lifecycle_projections FROM PUBLIC;
REVOKE ALL ON hawa.requests, hawa.lifecycle_projections FROM hawa_app;
GRANT SELECT, INSERT ON hawa.requests, hawa.lifecycle_projections TO hawa_app;
GRANT UPDATE (stage, rev, current_task_id, draft_sent_at, question_asked_at, updated_at) ON hawa.requests TO hawa_app;

COMMIT;
