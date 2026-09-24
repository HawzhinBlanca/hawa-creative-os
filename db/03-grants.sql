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
-- canva_export_bytes comes from migration 003, which runs after initdb (deploy.sh, upgrade.ts), and
-- 005 grants it SELECT and INSERT only. An unconditional REVOKE here failed every fresh data
-- directory with "relation does not exist" (found rehearsing the 2026-09-24 role rotation).
DO $$ BEGIN
  IF to_regclass('hawa.canva_export_bytes') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON hawa.canva_export_bytes FROM hawa_app;
  END IF;
END $$;
-- The file store (migration 019, ADR-035) is granted narrowly by its migration: blob rows are deleted
-- only by the collector's functions, and the reference view lists every tenant's files. If this file
-- is ever run again after 019, the blanket grant above must not undo that.
DO $$ BEGIN
  IF to_regclass('hawa.blobs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON hawa.blobs FROM hawa_app;
    GRANT UPDATE (unreferenced_since) ON hawa.blobs TO hawa_app;
  END IF;
  IF to_regclass('hawa.task_files') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON hawa.task_files FROM hawa_app;
  END IF;
  IF to_regclass('hawa.blob_references') IS NOT NULL THEN
    REVOKE ALL ON hawa.blob_references FROM hawa_app;
  END IF;
END $$;
REVOKE UPDATE, DELETE ON hawa.design_revisions FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.approvals FROM hawa_app;
REVOKE UPDATE, DELETE ON hawa.publications FROM hawa_app;

COMMIT;
