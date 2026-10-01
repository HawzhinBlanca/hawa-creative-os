# ADR-242 — Bind preserved model consent audits to the actual version pair

Date: 2026-10-02
Status: implementation and connected qualification in progress
Requirements: FR-054, FR-066, NFR-006, NFR-007
Sources: MASTER_SPEC.md invariants7–9; docs/14_SECURITY_THREAT_MODEL.md;
docs/18_FEEDBACK_LEARNING.md; ADR226/forward081; live ADR239.

## Evidence

Integrating live1e0616f0 with research8e813a0e reproduces three real API failures:
administrator DNA save, snapshot and rollback return500 because the new
`client.model_consent.kept` audit lacks purpose-specific INSERT authority.
Eight connected files:129 passed/3 failed; original receipt retained. The existing
grant/withdraw policies must remain intact; tenant-only INSERT would bypass them.

## Decision

Add forward082, leaving applied migrations unchanged. A kept-consent audit requires
the current enabled administrator, human actor, exact tenant/client, no task,
the actual new active DNA row approved/created by that actor, and the directly
preceding superseded approved human version. Both privacy objects must agree.
Resource ID, before/after hashes, version numbers, prior approver and recorded
privacy/actor data must name those exact rows. Permit only the three known save
routes. A restrictive policy also prevents an existing task policy bypass.

Service identities are not human approvers. The save helper reports missing prior
human consent rather than attempting to preserve service-issued approval. No new
provider permission, automatic consent grant, migration rewrite or actor substitution.

## Acceptance

The three actual routes succeed under hawa_app with matching audits. Direct actual
RLS controls refuse wrong actor/client/hash/version/privacy, absent prior approval,
service approval, changed privacy and task-policy bypass. Existing grant/withdraw,
tenant/client isolation and worker-role restrictions remain. Full qualification and
production-data migration validation are separate gates; no production write here.

## Qualification checkpoint — 2 October 2026

Connected7files90/0/0 and733 strict roots pass. Exact clean4748d969 full
7714 passed/2 failed/67 skipped: both explicit migration inventories still ended
at081. Their actual discovery/application returned082. Updated only the explicit
expected lists; actual startup refuses a missing082 and ordered/repeated migration
application remain tested. Four connected files38/0/0 pass. Six deployed-candidate
082 authority/checksum controls added; execution and full repaired rerun pending.
No production, native or human qualification. Earlier failure receipts retained.

## Existing Desk revision contract repaired

Full migration-inventory corrected source5dbad16e passes7716/0/67; seven
technical stages and negative flag refusal pass, production-dump Stage3 NOT_RUN.
A subsequent actual Desk handoff inspection found its full-DNA saves/snapshots
omitted the server expectedVersion field. Two strict UI cases reproduce missing
versions (6 pass/2 fail). The typed Desk API now requires that read revision and
its callers send it; no Core authorization/version check was relaxed. Real Core
refuses stale DNA/snapshot writes409 with unchanged versions/audits/consent.
Seven connected files91/0/0 and733 strict roots pass; two missing test-call
arguments were also corrected with explicit expected bodies. Final whole-source
qualification remains pending; the earlier7716 result applies only to5dbad16e.
