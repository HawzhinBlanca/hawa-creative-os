# ADR-164 — Shared office call-cost evidence

Date: 2026-09-30
Status: Accepted for implementation; release verification pending
Requirements: NFR-006, FR-063, FR-064, FR-065, FR-079

The owner requested recovery/accounting without individual sign-in for this
private team. Studio settlement already permits verified office authority
(ADR-159), but the exact-call accounting path still requires a named session.
Completed planner calls with unknown billing therefore cannot be reconciled
through the team's current Desk flow.

Permit a distinct `trusted_office_attestation` only when Core verified the office
proxy/origin policy in ADR-163. The route derives authority from authentication,
never the request body. SQL requires the matching shared administrator identity,
active administrator membership, and transaction-local office authority marker.
Named session evidence and automatic reservation expiry remain distinct.

Keep original provider receipts immutable. Preserve exact call ID, snapshot,
revision, reason, terminal provider evidence, idempotency replay and conflicting
cost/non-acceptance checks. A cost attestation does not resolve execution
uncertainty or authorize another design call. Display “Office team” explicitly;
it must never appear as an individual person's approval or provider receipt.

Regression evidence must include restart replay, competing/stale revisions,
forged office requests, named/shared key refusal, membership revocation and SQL
marker refusal. No production financial evidence is invented by tests.
