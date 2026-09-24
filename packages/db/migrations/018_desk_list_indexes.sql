-- Architecture programme 0.3 (2026-09-24): indexes for the Desk's task list.
-- GET /tasks pages on (created_at, id), newest first, and each row of a page looks up its latest QC
-- run and its latest approval. qc_runs was indexed only by design revision and approvals not at all,
-- so every row of every page scanned both tables whole: about 7 s a page at 5,000 tasks
-- (scripts/bench_task_list.ts). The Desk read every page every 30 s and after every task event.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the upgrade runner applies all migrations in one transaction,
-- and these tables are small enough (thousands of rows) that the brief write lock is not noticed.
CREATE INDEX IF NOT EXISTS tasks_list_idx ON hawa.tasks(tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS qc_runs_task_idx ON hawa.qc_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON hawa.approvals(task_id, created_at DESC);
