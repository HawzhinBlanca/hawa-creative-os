BEGIN;
-- Service identities (ADR-027): channel ingress and system automation write rows under their own
-- user ids instead of borrowing the Primary Operator. db/seed.sql carries the same rows for fresh
-- installations; both are idempotent. Each service identity receives the operator tenant role on
-- every tenant that exists when this runs, which is what RLS requires for task and outbox writes.
-- hawa.users forces RLS and has no INSERT policy, so this must run as the schema owner; a
-- non-bypassing role fails loudly here rather than silently inserting nothing.
INSERT INTO hawa.users (id, email, display_name)
VALUES
  ('00000000-0000-4000-b000-000000000010'::uuid, 'ingress@hawa.office', 'Channel Ingress'),
  ('00000000-0000-4000-b000-000000000011'::uuid, 'automation@hawa.office', 'System Automation')
ON CONFLICT DO NOTHING;

INSERT INTO hawa.tenant_memberships (tenant_id, user_id, role, active)
SELECT t.id, u.id, 'operator'::hawa.membership_role, true
FROM hawa.tenants t
CROSS JOIN (VALUES
  ('00000000-0000-4000-b000-000000000010'::uuid),
  ('00000000-0000-4000-b000-000000000011'::uuid)) AS u(id)
ON CONFLICT (tenant_id, user_id, role) DO NOTHING;
COMMIT;
