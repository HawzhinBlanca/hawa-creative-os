# ADR211 — Explicit synthetic provider failures in candidate recovery

Date: 2026-10-01
Status: Accepted; connected and actual deployed synthetic controls verified
Requirements: FR-074, NFR-024, NFR-025
Sources: docs/10_WORKFLOW_RELIABILITY.md, MASTER_SPEC; ADR205 candidate parity.

The two unmatched Gemini calls in ADR210's98-check candidate rehearsal are
intentional evaluation-settlement failures, not unexpected design calls. The
rehearsal currently obtains them from an unsupported fake endpoint's default500.
That leaves fault intent indistinguishable from missing fixture coverage. Preserve
those raw receipts and clarify the scope; do not fabricate successful model work.

Arm a bounded model-specific Gemini503 fault explicitly before evaluation. Match
only POST generateContent on the exact provider/model endpoint. Unmatched calls
continue to refuse and remain visible. Record Gemini's model from its request URL
instead of the absent body.model: otherwise different requested models collide in
the fake fingerprint ledger. No private request text or keys enter that ledger.

The deployed settlement proof must observe exactly the two armed failures on the
named model, with no additional calls during settlement/replay/restart, and retain
unknown original cost. After consuming the fault, the endpoint remains unsupported.
Do not add a generic provider simulator, successful Gemini fixture or new dependency.
Production model routing, budget, uncertainty, settlement authority and credentials
are unchanged. This improves deterministic failure evidence, not model quality.

Acceptance: real TLS fake controls for model identity, exact fault scope/count,
wrong method/path/provider and exhaustion; actual deployed named settlement and
replay. Keep earlier unsupported-failure receipts. Source qualification is separate
from production-dump/native/human/product admission.

## Qualification

Final4files78connected tests/687 strict roots/lint pass. Clean132e500c
actual candidate passes78 named checks and zero unconfigured model calls;
exact2 armed503 requests and named settlement/restart/replay are verified.
Source drift0, images match candidate,56 unselected scenarios skipped.
Default teardown removes containers/volumes. Providers/staff remain synthetic.
Current full monorepo gate and unchanged backup restores were not repeated for
this testkit-only change; prior6812/98 results remain historical. Production-dump
authorization, native/human/separate-host and product admission remain open.
