-- 023: the request lifecycle's projection in Postgres (architecture programme Phase 2, slice 2.3;
-- PHASE2_DESIGN.md section 2.8, ADR-034).
--
-- A request opened by the RequestLifecycle object in Restate (a chat on HAWA_LIFECYCLE_CHATS) is one
-- row of hawa.requests: its owner, where it is in its life (stage) and its revision. The object
-- decides; this table is what the Desk and every legacy query read. It is written by Core's projection
-- endpoint only (POST /v1/internal/lifecycle/:requestId/project), in one transaction that checks the
-- expected revision and records the projection under its idempotency key in
-- hawa.lifecycle_projections, so the same projection asked again is answered from the record.
--
-- Each round of a request (the first design, a change, an answer to a question) keeps its own task, as
-- today; tasks.request_id names the request. NULL is a request Core owns (every task before this, and
-- every task made in the Desk during Phase 2). No foreign key there: a request's row names its root
-- task, and a task is written before its request row in the same transaction.
--
-- The owner is written once and never changed, and a revision never goes back: the application may
-- update only the columns that move (column grants below), and a trigger refuses a lower revision.
-- A projection record is never rewritten or removed by the application.
--
-- Access follows the request's root task, as for every task-scoped table (db/rls.sql), in the hoisted
-- form of migration 016 (ADR-033). The same definitions are in db/schema.sql, db/rls.sql and
-- db/03-grants.sql for a database built from nothing. Every statement can run twice (psql by hand
-- after the runner, or after those files): IF NOT EXISTS, or a DROP IF EXISTS just before.
BEGIN;

CREATE TABLE IF NOT EXISTS hawa.requests (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  root_task_id uuid NOT NULL,
  current_task_id uuid NOT NULL,
  parent_request_id uuid,
  owner text NOT NULL CHECK (owner IN ('core', 'restate')),
  stage text NOT NULL CHECK (stage IN ('designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering', 'delivered', 'expired', 'cancelled')),
  rev bigint NOT NULL DEFAULT 0 CHECK (rev >= 0),
  chat_id text CHECK (chat_id IS NULL OR length(chat_id) <= 64),
  draft_sent_at timestamptz,
  question_asked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, root_task_id) REFERENCES hawa.tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, current_task_id) REFERENCES hawa.tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_request_id) REFERENCES hawa.requests(tenant_id, request_id)
);
CREATE INDEX IF NOT EXISTS requests_tenant_stage_idx ON hawa.requests(tenant_id, stage, updated_at DESC);

ALTER TABLE hawa.tasks ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE INDEX IF NOT EXISTS tasks_request_idx ON hawa.tasks(tenant_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hawa.lifecycle_projections (
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  rev bigint NOT NULL CHECK (rev > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  -- sha256 of the projection's ops: the same key with other ops is refused, not replayed.
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, request_id, rev),
  FOREIGN KEY (tenant_id, request_id) REFERENCES hawa.requests(tenant_id, request_id) ON DELETE CASCADE
);

-- A revision never goes back, and a request never changes tenant, owner or root task. The grants
-- below already keep the application from writing those columns; this holds for every role.
CREATE OR REPLACE FUNCTION hawa.requests_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = hawa, public AS $$
BEGIN
  IF NEW.rev < OLD.rev THEN
    RAISE EXCEPTION 'request % is at revision %, it cannot go back to %', OLD.request_id, OLD.rev, NEW.rev USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.owner IS DISTINCT FROM OLD.owner OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.root_task_id IS DISTINCT FROM OLD.root_task_id THEN
    RAISE EXCEPTION 'request %: owner, tenant and root task are written once', OLD.request_id USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS requests_guard ON hawa.requests;
CREATE TRIGGER requests_guard BEFORE UPDATE ON hawa.requests FOR EACH ROW EXECUTE FUNCTION hawa.requests_guard();

ALTER TABLE hawa.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS requests_task_select ON hawa.requests;
CREATE POLICY requests_task_select ON hawa.requests FOR SELECT USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (SELECT 1 FROM hawa.tasks tx WHERE tx.id = requests.root_task_id)
);
DROP POLICY IF EXISTS requests_task_write ON hawa.requests;
CREATE POLICY requests_task_write ON hawa.requests FOR ALL USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.tasks tx
    WHERE tx.id = requests.root_task_id
      AND (tx.client_id IS NULL OR (tx.tenant_id = hawa.current_tenant_id() AND (
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[]))
        OR tx.client_id = ANY ((SELECT hawa.member_client_ids(true))::uuid[])
      )))
  )
) WITH CHECK (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.tasks tx
    WHERE tx.id = requests.root_task_id
      AND (tx.client_id IS NULL OR (tx.tenant_id = hawa.current_tenant_id() AND (
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[]))
        OR tx.client_id = ANY ((SELECT hawa.member_client_ids(true))::uuid[])
      )))
  )
);

ALTER TABLE hawa.lifecycle_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.lifecycle_projections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lifecycle_projections_task_select ON hawa.lifecycle_projections;
CREATE POLICY lifecycle_projections_task_select ON hawa.lifecycle_projections FOR SELECT USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (SELECT 1 FROM hawa.requests r WHERE r.request_id = lifecycle_projections.request_id)
);
DROP POLICY IF EXISTS lifecycle_projections_task_write ON hawa.lifecycle_projections;
CREATE POLICY lifecycle_projections_task_write ON hawa.lifecycle_projections FOR INSERT WITH CHECK (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.requests r JOIN hawa.tasks tx ON tx.id = r.root_task_id
    WHERE r.request_id = lifecycle_projections.request_id
      AND (tx.client_id IS NULL OR (tx.tenant_id = hawa.current_tenant_id() AND (
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[]))
        OR tx.client_id = ANY ((SELECT hawa.member_client_ids(true))::uuid[])
      )))
  )
);

-- db/03-grants.sql grants every table in the schema; these get exactly what the projection needs.
REVOKE ALL ON hawa.requests FROM PUBLIC;
REVOKE ALL ON hawa.lifecycle_projections FROM PUBLIC;
REVOKE ALL ON hawa.requests FROM hawa_app;
REVOKE ALL ON hawa.lifecycle_projections FROM hawa_app;
GRANT SELECT, INSERT ON hawa.requests TO hawa_app;
GRANT UPDATE (current_task_id, stage, rev, draft_sent_at, question_asked_at, updated_at) ON hawa.requests TO hawa_app;
GRANT SELECT, INSERT ON hawa.lifecycle_projections TO hawa_app;
-- tasks.request_id is written with the task (INSERT, which the application has on tasks).

COMMIT;
