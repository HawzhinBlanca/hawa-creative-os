-- ADR-200: the intake router also reads an office member's words about the drafts waiting for review,
-- once per Telegram update, in the same ledger and the same shared daily allowance (role intake_router,
-- ADR-144 / migration 068). An office reading concerns drafts of possibly several clients, so it names
-- no client: it is charged to the office and to the role, never to one client's allowance. A requester
-- reading still names its one client. One reading per update and reader: an office member's update that
-- the office turn leaves to intake may still be read once by the requester router.
BEGIN;
ALTER TABLE hawa.requester_intent_calls
  ADD COLUMN reader text NOT NULL DEFAULT 'requester' CHECK (reader IN ('requester','office'));
ALTER TABLE hawa.requester_intent_calls ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE hawa.requester_intent_calls
  ADD CONSTRAINT requester_intent_call_client CHECK (reader = 'office' OR client_id IS NOT NULL);
ALTER TABLE hawa.requester_intent_calls DROP CONSTRAINT requester_intent_calls_tenant_id_update_id_key;
ALTER TABLE hawa.requester_intent_calls
  ADD CONSTRAINT requester_intent_calls_reader_update UNIQUE (tenant_id, reader, update_id);
COMMIT;
