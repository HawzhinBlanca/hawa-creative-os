# ADR-065: Chat notifications open the named Desk review

- Date: 2026-09-26
- Status: Accepted
- Requirements: FR-041, FR-043, FR-044, FR-060, NFR-015
- Sources: docs/12_HUMAN_REVIEW.md §8; ADR-064

## Decision and reason

Use the specification's Desk handoff for office review. A chat notification links to
`/#/work?task=<uuid>&revision=<uuid>` for the recorded draft. Opening it is navigation,
not a decision or authority grant. The existing Desk decision transaction rechecks the
named session, membership and client/project assignment and binds approval to stored
revision, QA and exports. Requester feedback buttons retain their separate meaning.
This keeps one authoritative decision path instead of duplicating it in chat handlers.

The link opens its own task even outside the queue page. An unavailable task never
substitutes a different queue entry. When the current revision differs from the link,
Desk disables decisions until the reviewer explicitly chooses to review that current
revision. A subsequent revision change requires another acknowledgement. The database
still rejects stale decisions; this UI guard is additional context, not authorization.
Legacy `#task-<uuid>` notifications remain readable without claiming a pinned revision.

Google sign-in accepts only task/revision UUIDs, stores them with the single-use,
five-minute OAuth state, and builds a same-origin path after authentication. Callback
query parameters cannot change the destination. Migration 039 adds these nullable
navigation fields; existing flows continue returning to the queue. They are not foreign
keys or evidence of access: task authorization happens after sign-in.

Server notification URLs use the configured public HTTPS Desk origin only, without
credentials, query or fragment. Missing/invalid configuration omits the link. An origin
is never inferred from a request Host header or a worker-supplied URL. The legacy chat
approval endpoint returns an explicit 409 handoff with `decisionRecorded: false` and a
local review path after its existing validation; it never acknowledges an approval.

## Evidence and limits

Regression tests cover navigation, unavailable and stale tasks, sign-in return binding,
malformed destinations, persisted notification links and unchanged decision counts.
Local controlled identity-provider tests do not qualify live Google Workspace, Telegram
click-through, production migrations, or a human's visual/language review.
