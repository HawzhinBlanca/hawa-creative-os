# ADR278 — Explicit customer generation runtime configuration

Date: 2026-10-03. Status: local native intake qualified; public/full worker admission open.
Requirements: FR-001/006/017/068/069, NFR-006/012/024/025.
Sources: MASTER_SPEC.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md,
docs/14_SECURITY_THREAT_MODEL.md, docs/17_UI_UX.md, docs/30_CURRENT_STUDIO_CONTRACT.md,
ADR259/260/277 and current production entrypoint/customer routes.

The production entrypoint already maps HAWA_CUSTOMER_GENERATION_ENABLED=on to
customerApi.generationEnabled, but createApp discards it and passes false. This
prevents an actual production-shaped private browser/worker rehearsal, even after
the individual lifecycle/upload/preview/action/acceptance slices are installed.
Do not qualify a second test-only HTTP router as the production factory.

Honor only the literal server option true in createApp. Absent/false remains off.
The production environment must explicitly enable both customer API and generation,
and supply its public workspace authentication configuration. Reject malformed
customer switches or generation-on/API-off rather than silently ignoring them.
These are startup settings, never a browser/request/model-controlled capability.
Generation off still blocks uploads, creation and actions. Required office auth,
native member verification, current account/client RLS, immutable receipt/scope,
quota/spend limits, idempotency, durable outbox and all native/human approval and
download gates remain mandatory. No alternative pipeline or fabricated approval.

Keep deployed/default generation off and Designer Soon until the whole hosted
customer/worker/native Canva/RTL/recovery/quality/release gates pass. A local owned
Core may explicitly enable the existing switch for private admission work; this
does not authorize enabling public generation or waive remaining release gates.
Record exact real and synthetic boundaries separately.
