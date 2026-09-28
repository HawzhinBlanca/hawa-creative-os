-- ADR-043: task queues read the latest request-owned publication to expose a Sheet retry.
BEGIN;

CREATE INDEX IF NOT EXISTS publications_tenant_task_created_idx
  ON hawa.publications (tenant_id, task_id, created_at DESC);

COMMIT;
