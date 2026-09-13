# ADR-027: Service identities for adapters and automation

**Date:** 2026-09-13
**Status:** Accepted

## Context

Every row written through PostgreSQL row-level security carries a user id, and the audit trail
(`tasks.requested_by`, `task_events.actor_id`, session bookkeeping) is only as honest as that id.
Until this decision, channel adapters (Telegram, WhatsApp, unified ingress), the ingress persistence
adapter, the legacy task `create()` path, chat-trigger state transitions, workflow completion, the
publisher audit and Desk session bookkeeping all wrote under the seeded **Primary Operator**
(`…b000-000000000001`) because it was the only operator row that existed. The ingress adapter also
opened its transactions with the `administrator` role although nothing it writes needs it.

Consequences of that shortcut: a task created by an unknown Telegram sender was recorded as
requested by the office's human operator; an automatic publication was audited as authorised by the
same person; and the operator's identity was the credential of record for machine work, which makes
a future revocation of that person's access impossible without breaking ingress.

## Decision

Two seeded **service identities** with the `operator` tenant role, shipped in `db/seed.sql` for
fresh installations and in migration `012_service_identities.sql` for existing databases:

| Identity | User id | Used for |
|---|---|---|
| Channel Ingress | `00000000-0000-4000-b000-000000000010` | Rows created because a message arrived: chat intake, ingress persistence, unified ingress task creation, legacy `create()`, chat-trigger approvals and publishing transitions |
| System Automation | `00000000-0000-4000-b000-000000000011` | Rows created by Core or the worker on their own: Desk session bookkeeping, task hydration reads, workflow completion, publisher audit entries |

The ids live in `@hawa/contracts` (`identities.ts`) because it is the one package under both
`@hawa/db` and `@hawa/integrations`. The migration grants both identities the `operator` role on
every tenant present at migration time; a tenant created later needs the same two membership rows.
The ingress persistence adapter now opens its transactions as `operator`, which is the least role
that satisfies the `tasks_write`, tenant-table and task-scoped policies.

Human identities are untouched: credentials still resolve to Primary Operator or Art Director, and
`auth.userId || PRIMARY_OPERATOR` defaults on authenticated routes remain because those requests
were made by a person holding an operator credential.

## Consequences

- `requested_by` and `actor_id` now distinguish a human decision from a channel event or automation.
  Reports that grouped work by operator will show the two new display names; that is the truth.
- RLS behaviour is unchanged for humans. A database that has not applied migration 012 will refuse
  adapter writes (foreign key on `requested_by`, no membership), which is loud rather than wrong.
- Rollback: revert the code and keep the rows; the rows are harmless without callers.

## Verification

- `packages/contracts/test/identities.test.ts` (shape, distinctness, human/service classification).
- `apps/core/test/chat-intake-durability.test.ts` proves on a real database that a Telegram task is
  attributed to Channel Ingress and not to the Primary Operator.
- `packages/db/test/schema-upgrade.test.ts` verifies migration 012 applies once and re-verifies.
