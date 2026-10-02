# ADR266 — Independent customer acceptance and current-file downloads

Date: 2026-10-03. Status: selected; qualified locally; hosted/native/customer admission pending.
Requirements: FR-029/032 (docs/05_CREATIVE_ENGINE.md), FR-043 (docs/11_QA_RTL_MULTILINGUAL.md), FR-069 (docs/14_SECURITY_THREAT_MODEL.md), NFR-006/008/011/015 (MASTER_SPEC.md).
ADR256/259–265 remain binding. Canva admission remains conditional.

## Decision

A verified customer accepts exactly the checked PNG/PPTX identities and complete
native-review evidence fingerprint through the existing immutable customer action,
outbox and canonical private RequestLifecycle. Core repeats actual file checks and
Canva observation outside a transaction, reauthorizes live ownership and compares
all evidence at commit. The sole pending-action exception is the stored verified
accept action being projected; every other pending action blocks. Reconciliation
returns a committed outcome before provider access, even after permission changes.

Acceptance creates a separate attributable append-only receipt, advances the owner
revision once while retaining its current task and in_review stage, and is visible
only after durable owner acknowledgement. It never creates staff approval, marks
an office task delivered, publishes to Drive or promotes taste rules. A later
revision, capture, binding, QA, source, client-policy or grant change invalidates it.
The evidence comparison normalizes only the acceptance's own request-version
increment; all other fields must match exactly.

Each download requires the owned, applied, current receipt and exact version,
format, artifact ID and hash; it rechecks actual bytes/QA, observes Canva afresh
and reauthorizes evidence afterward. Only actual PNG/editable PPTX bytes ship,
with bounded complete request concurrency, no-store, nosniff and server-generated
attachment filenames. PDF is not advertised without native captured evidence.
Canva timestamps have second precision; observation cannot prove every same-second
edit absent or atomically lock a remote editor with PostgreSQL.

Concurrent quota counts current web requests, excluding an exactly matching
applied acceptance. A revision from accepted work reserves its slot when admitted
under the same account lock as generation; pending revision actions count. No new
workflow, dependency or customer-facing staff role is introduced.

## Qualification

Require restricted-role database, mounted HTTP, worker replay/acknowledgement and
browser stale-state/idempotency/download controls, including changed native state,
revoked access, lost responses, pending actions and actual corrupted file bytes.
Hosted Supabase/native Canva/RTL/human acceptance remain separate launch gates.


Final sealed3334b115:8128 passed/0 failed/67 skipped;98 focused controls,
746 strict roots, build/scripts types/provider egress/any952<=1053/scanner pass.
Website a8fdd2e:863/0/0 and9 Chromium synthetic Auth/Core controls, types/build/
lint/scanner pass. Blueprint1953/0/0 and release source seal verified. Original
SQL/fixture/constraint/browser-CORS/locator/scanner-wrapper failures remain in
CUSTOMER_ACCEPTANCE_PROOF.json. No deployment or public/native/human claim.
