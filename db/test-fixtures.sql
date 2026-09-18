-- Rows the plain suite (hawa_test) needs beyond db/seed.sql. Applied to hawa_test only, by
-- packages/db/src/provision-isolated-test-db.ts; never mounted into a production database.
-- Until 2026-09-18 these rows existed only in a hand-maintained hawa_test on the production server,
-- so a freshly provisioned database failed 15 tests with RLS and foreign-key violations.

BEGIN;
SET search_path = hawa, public;

-- Each isolation tenant (seed.sql, tenants 5-8) has its own administrator; the suites act as
-- user b...00N inside tenant a...00N (outbox-consumer: 6, durable-workflow-recovery: 5,
-- unified-ingress-postgres: 7, telegram and waha adapters: 8).
INSERT INTO users (id, email, display_name)
VALUES
  ('00000000-0000-4000-b000-000000000005'::uuid, 'admin-tenant-5@test.invalid', 'Test Tenant 5 Administrator'),
  ('00000000-0000-4000-b000-000000000006'::uuid, 'admin-tenant-6@test.invalid', 'Test Tenant 6 Administrator'),
  ('00000000-0000-4000-b000-000000000007'::uuid, 'admin-tenant-7@test.invalid', 'Test Tenant 7 Administrator'),
  ('00000000-0000-4000-b000-000000000008'::uuid, 'admin-tenant-8@test.invalid', 'Test Tenant 8 Administrator')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_memberships (tenant_id, user_id, role, active)
VALUES
  ('00000000-0000-4000-a000-000000000005'::uuid, '00000000-0000-4000-b000-000000000005'::uuid, 'administrator', true),
  ('00000000-0000-4000-a000-000000000006'::uuid, '00000000-0000-4000-b000-000000000006'::uuid, 'administrator', true),
  ('00000000-0000-4000-a000-000000000007'::uuid, '00000000-0000-4000-b000-000000000007'::uuid, 'administrator', true),
  ('00000000-0000-4000-a000-000000000008'::uuid, '00000000-0000-4000-b000-000000000008'::uuid, 'administrator', true)
ON CONFLICT (tenant_id, user_id, role) DO NOTHING;

-- Clients the suites create tasks for (durable-workflow-recovery: tenant 5; telegram and waha: tenant 8).
INSERT INTO clients (id, tenant_id, code, name, default_language, status)
VALUES
  ('c1000000-0000-4000-8000-000000000005'::uuid, '00000000-0000-4000-a000-000000000005'::uuid, 'test-client-5', 'Test Tenant 5 Client', 'en', 'active'),
  ('00000000-0000-4000-c000-000000000008'::uuid, '00000000-0000-4000-a000-000000000008'::uuid, 'test-client-8', 'Test Tenant 8 Client', 'en', 'active')
ON CONFLICT (id) DO NOTHING;

COMMIT;
