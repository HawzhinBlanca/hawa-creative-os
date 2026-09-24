-- 021: reviewers' comments on a task's design (architecture programme 1.3, group G3, 2026-09-24).
--
-- POST and GET /tasks/:taskId/comments (Gate F: "node comments ... create new revisions/diffs",
-- docs/29_ACCEPTANCE_GATES.md) kept every comment in a map in Core's memory, so a restart lost them
-- and a second Core process never saw them. No table held them: audit_events records who did what,
-- not the review conversation, and feedback_events is the learning signal for a client's rules. This
-- table is where they live now.
--
-- A comment is never edited or removed by the application: it gets SELECT and INSERT only. It
-- belongs to a task (deleting the task takes it) and may name one of that task's revisions and a
-- node in it. Access follows the task, as for every task-scoped table (db/rls.sql), in the hoisted
-- form of migration 016 (ADR-033).
--
-- Every statement can run twice (psql by hand after the runner): IF NOT EXISTS, or a DROP IF EXISTS
-- just before.
BEGIN;

CREATE TABLE IF NOT EXISTS hawa.review_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  design_revision_id uuid,
  node_id text CHECK (node_id IS NULL OR length(node_id) <= 200),
  -- The reviewer's stage role the route's policy admitted; the signed-in caller is author_user_id.
  author_role text NOT NULL CHECK (author_role IN ('art_director','creative_director','client_reviewer','operator')),
  author_user_id text NOT NULL CHECK (length(author_user_id) <= 200),
  author_display_name text NOT NULL CHECK (length(author_display_name) <= 200),
  body text NOT NULL CHECK (length(body) <= 10000),
  category text NOT NULL CHECK (length(category) <= 100),
  priority text NOT NULL CHECK (length(priority) <= 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES hawa.tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, design_revision_id) REFERENCES hawa.design_revisions(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS review_comments_task_idx ON hawa.review_comments(tenant_id, task_id, created_at);

ALTER TABLE hawa.review_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.review_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_comments_task_select ON hawa.review_comments;
CREATE POLICY review_comments_task_select ON hawa.review_comments FOR SELECT USING (
  tenant_id = hawa.current_tenant_id() AND EXISTS (SELECT 1 FROM hawa.tasks tx WHERE tx.id = review_comments.task_id)
);
DROP POLICY IF EXISTS review_comments_task_write ON hawa.review_comments;
CREATE POLICY review_comments_task_write ON hawa.review_comments FOR INSERT WITH CHECK (
  tenant_id = hawa.current_tenant_id() AND EXISTS (
    SELECT 1 FROM hawa.tasks tx
    WHERE tx.id = review_comments.task_id
      AND (tx.client_id IS NULL OR (tx.tenant_id = hawa.current_tenant_id() AND (
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[]))
        OR tx.client_id = ANY ((SELECT hawa.member_client_ids(true))::uuid[])
      )))
  )
);

REVOKE ALL ON hawa.review_comments FROM PUBLIC;
-- db/03-grants.sql grants every table in the schema; this one gets exactly these.
REVOKE ALL ON hawa.review_comments FROM hawa_app;
GRANT SELECT, INSERT ON hawa.review_comments TO hawa_app;
COMMIT;
