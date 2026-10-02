# ADR259: customer-owned web requests on the existing worker

Date: 2026-10-02. Status: accepted implementation direction; public admission pending.
Requirements: FR-001, FR-006, FR-017, FR-054, FR-068, NFR-006; sources:
`docs/09_messaging_intake.md`, `docs/14_security_identity.md`,
`docs/17_ui_spec.md`, `docs/30_CURRENT_STUDIO_CONTRACT.md`, ADR256.

A verified hawzhin.app member receives no office authority. An administrator must
provision a dedicated requester identity and active client grants. Identity,
tenant and task ownership are immutable. Provisioning/revocation is audited.
Customer transactions set a separate, transaction-local subject/account context.
Restrictive RLS policies prevent the existing shared-client and tenant-wide read
policies from exposing other customers' tasks or operational tables. Customer
writes are limited to initial task/event/outbox creation; staff approval,
publication, role and DNA mutations remain unavailable. Elevated or disabled
mapped identities fail closed.

Serialize submissions per customer, recheck live grants under row locks, then
replay an exact idempotency receipt before applying request-count/concurrency
limits. New requests pin the active DNA version and write task, event and pending
outbox atomically. The synthetic dispatch path currently names TaskWorkflow. Production generation remains disabled until it is replaced by the canonical RequestLifecycle web adapter. Reuse the existing Canva Studio worker and its monetary ledger;
no second design engine or browser provider keys. Request limits bound admission;
they are not a billing product or a claim of per-customer monetary settlement.

The customer API is explicit opt-in, unavailable in trusted-office mode, and
uses only verified Supabase member credentials. Its exact site-origin CORS policy
does not broaden office CORS. Initial qualified scope is customer permission and synthetic job intake/history/status;
source uploads, preview, revisions and artifact downloads require subsequent
qualified slices. The public launcher stays Coming Soon until that complete real
journey and production hosting pass. This ADR does not admit a public release.
