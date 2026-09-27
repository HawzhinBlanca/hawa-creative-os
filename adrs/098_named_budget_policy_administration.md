# ADR-098 — Named administration of the shared spending policy

Date: 2026-09-27
Status: Accepted for implementation; qualification pending
Requirements: FR-060, FR-062, FR-065, FR-079, NFR-001.
Sources: docs/10_WORKFLOW_RELIABILITY.md, docs/14_SECURITY_THREAT_MODEL.md,
docs/17_UI_UX.md and MASTER_SPEC.md.

## Decision and reason

Expose the existing office/client/model-role daily policy in Desk Operations.
An active named office administrator may append a revision after reviewing its
changes and supplying a reason. Keep the existing policy table, ledger aggregate,
Asia/Baghdad day and admission lock; do not introduce another budget counter.
Runtime table writes remain denied. A narrowly granted SQL function verifies the
current named session, tenant, user, expected version and canonical limits hash,
then appends one attributed revision under the existing office spending lock.
This extends ADR-092's owner-only administration without weakening its accounting.

The action UUID binds the actor and canonical complete request. Check replay before
the current revision so a committed action whose answer was lost can be recovered
after other changes. Recheck authority on replay. Store the actor separately from
the database connection identity; historical bootstrap/owner revisions have no
invented human attribution. Direct application inserts/updates/deletes stay denied.

Office, default client, default role, explicit client and role limits are finite
nonnegative USD, at most one million, in whole micro-dollars. Validate in pure
domain code and again in SQL; client overrides must belong to the current office.
Zero stops new spending within that scope. A lower limit may be below existing
obligations: retain them, show the resulting hold, and apply the limit to subsequent
admissions. Raising a limit neither releases unknown cost nor resolves missing
history. Never cancel or restart paid work as a consequence of a policy change.

Operators and auditors may inspect current policy, daily usage and paginated
history. Only a named administrator receives editable controls. Desk shows old and
proposed limits and the reason before submission, saves the exact action before
transport, and retains it through an uncertain response and reload. Scope saved
actions by tenant and user. Report definite stale-input refusal separately from an
unconfirmed outcome. Removing an override restores the visible default.

## Verification

Prove named authority, shared-key refusal, revocation, tenant/client isolation,
SQL entry-point guards and immutable history. Race two changes against the same
revision, replay an old successful action after a newer revision, and reject a
changed payload with the same action. Verify real admission is serialized with a
policy change, existing obligations survive lowering and restart, and no provider
transport occurs during configuration. Exercise Desk review, uncertain POST/remount
retry, inheritance and stale refusal, plus actual deployed cookie/CSRF flow.
Live provider billing and whole-app admission remain separate open requirements.

Desk consumes the pure validation module through an explicit browser-safe domain
export. The initial package-wide import pulled existing server crypto helpers into
the browser build; the narrow export shares rules without browser polyfills or a
new third-party dependency. The existing pnpm store is reused for workspace links.
