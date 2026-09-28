-- 03-grants.sql
-- Least-privilege runtime role grants for hawa_app (DB-06)
--
-- hawa_app executes daily application reads and writes under RLS.
-- Global tables require narrow grants; append-only audit & receipt tables
-- explicitly revoke UPDATE and DELETE so records cannot be rewritten or erased.
--
-- This is the init script of an empty data directory (docker-compose.prod.yml mounts it into
-- /docker-entrypoint-initdb.d); it runs before the versioned upgrades (packages/db/src/upgrade.ts),
-- and from then on every migration grants its own tables. Run again after the runner, its blanket
-- GRANT re-widened every table a migration had narrowed, its REVOKE on publications dropped
-- migration 022's executor column grants, so Restate-owned deliveries could not be claimed or
-- finished, and hawa.schema_upgrades became writable by the application (ADR-128). The runner
-- creates hawa.schema_upgrades before its first migration, so once that table exists this file
-- changes nothing and says so. A re-grant after the runner belongs in a migration.

BEGIN;

DO $$ BEGIN
  IF to_regclass('hawa.schema_upgrades') IS NOT NULL THEN
    RAISE NOTICE '03-grants.sql: the versioned upgrades have run (hawa.schema_upgrades exists); their grants stand and this init script changes nothing';
    RETURN;
  END IF;

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
  -- Tables the migrations create (canva_export_bytes from 003, blobs and task_files from 019,
  -- review_comments from 021, requests and lifecycle_projections from 023, …) do not exist yet here:
  -- each migration grants its own. This file used to repeat some of those grants for a re-run after
  -- the runner, which now changes nothing (above).
  REVOKE UPDATE, DELETE ON hawa.design_revisions FROM hawa_app;
  REVOKE UPDATE, DELETE ON hawa.approvals FROM hawa_app;
  REVOKE UPDATE, DELETE ON hawa.publications FROM hawa_app;
  REVOKE UPDATE, DELETE ON hawa.drive_upload_reservations FROM hawa_app;

  -- Three of the tables above are not append-only in use: a row moves through states. The REVOKEs
  -- took UPDATE away entirely, so a database built from an empty data directory (this file is its
  -- init script) left the worker unable to claim a command ("permission denied for table
  -- outbox_commands", chaos harness 2026-09-24), approvals unable to mark their revision and
  -- deliveries unable to finish. The test databases never run this file, so no test saw it. Only the
  -- columns the code moves are granted; what a row says it is (payload, key, hashes) stays fixed.
  -- apps/worker/test/fresh-production-init.test.ts builds a database from these scripts and runs
  -- the worker's outbox on it as this role.
  GRANT UPDATE (state, available_at, leased_until, attempts, last_error, delivered_at) ON hawa.outbox_commands TO hawa_app;
  GRANT UPDATE (status) ON hawa.design_revisions TO hawa_app;
  GRANT UPDATE (state, error_class, error_detail, updated_at, completed_at) ON hawa.publications TO hawa_app;
END $$;

COMMIT;
