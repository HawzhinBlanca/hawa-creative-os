# R21 — Unknown model acceptance is not a free retry

**Date:** 2026-09-25. **Status:** in progress. **Branch:** `codex/research-grade-design-system`. **Decision:** ADR-048. **Requirements exercised:** FR-059, FR-060, FR-065, FR-079, NFR-001. Linked contracts: `docs/07_MODEL_REGISTRY_AND_EVALUATION.md`, `docs/10_WORKFLOW_RELIABILITY.md`, `MASTER_SPEC.md`.

## Red-before observation

The Studio OpenAI client retried a lost text request three times while treating a missing HTTP response as proof of no charge. The same client could repeat an image request. The generated-art adapter retried HTTP 5xx or a dropped connection, then returned a procedural result with a zero-dollar receipt even though the provider could have accepted one or both image requests. The Studio ledger wrapper finalized a lost call as a zero-dollar `error`, and a fresh resume had no guard against the pre-dispatch `uncertain` row left by a killed worker.

Negative tests reproduced the text behavior (**3 failed**) and generated-art behavior (**3 failed**) before the source changes. A separate Core ledger/restart test failed before its guard was added. The tests use fake provider responses and an isolated PostgreSQL database where applicable; no paid provider request was made.

## Local change

- A lost connection or HTTP 5xx stops the OpenAI text/image client after one attempt and reports unknown acceptance. Explicit 429 retains bounded retry. The generated-art adapter applies this to OpenAI and Google image requests. A 200 response whose image payload cannot be read is also unknown, and the adapter does not conceal it behind a procedural fallback.
- Studio records these outcomes as `uncertain` in its pre-dispatch call ledger. A previously accepted image rejected by a local check still contributes its known cost when a later attempt becomes uncertain.
- A fresh active Studio resume refuses to run if any call in that run is unresolved, including an inserted row left by a crash. It requires operator reconciliation; this slice does not invent a provider lookup or auto-clear the row.
- The run evidence endpoint reports `uncertainCallsCount`, `knownUsdEstimate`, a null `totalUsdEstimate`, and null per-call cost for unresolved calls. The persisted numeric zero remains an internal placeholder, not a claim that the provider charged nothing.

## Verification and limits

Focused controls: **4 files / 63 tests passed**. The first full source run found 51 failures across nine test files because their small repository doubles lacked the new ledger-read method. Adding an empty-ledger response to those doubles made the affected **9 files / 99 tests** pass. The corrected full source suite passed **420 files / 3,204 tests**, with **4 files / 48 tests skipped**. Workspace/test TypeScript and lint passed; the provider egress lint still records **9 existing direct-call exceptions**. The security scan found **0 secrets** in committable files. Pack validation, sealed manifest and exact-candidate assessment are recorded in the checkpoint below when run.

This does not finish R21. Calls still lack a stable hash-bound logical identity and provider reconciliation by request ID; other direct adapters and evaluation scripts still need the same policy and durable budget admission. No killed provider process, actual bill, production canary, or clean-host restore was tested. The R21 work item remains in progress and production flags remain off.
