-- 03-grants.sql
-- Least-privilege runtime role grants for hawa_app (DB-06)
--
-- hawa_app executes daily application reads and writes under RLS.
-- Global tables require narrow grants; append-only audit & receipt tables
-- explicitly revoke UPDATE and DELETE so records cannot be rewritten or erased.

BEGIN;

GRANT USAGE ON SCHEMA hawa TO hawa_app;
GRANT USAGE ON SCHEMA public TO hawa_app;

-- Grant standard DML to hawa_app on tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hawa TO hawa_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hawa TO hawa_app;

-- Narrow append-only tables: immutable audit trails & financial ledgers
REVOKE UPDATE, DELETE ON hawa.outbox_commands FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.inbox_events FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.message_events FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.task_events FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.qc_runs FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.canva_export_bytes FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.design_revisions FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.approvals FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.publications FROM hawa_app;

COMMIT;
