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

Focused controls: **4 files / 63 tests passed**. The first full source run found 51 failures across nine test files because their small repository doubles lacked the new ledger-read method. Adding an empty-ledger response to those doubles made the affected **9 files / 99 tests** pass. The corrected full source suite passed **420 files / 3,204 tests**, with **4 files / 48 tests skipped**. Workspace/test TypeScript and lint passed; the provider egress lint still records **9 existing direct-call exceptions**. The security scan found **0 secrets** in committable files.

## Sealed source checkpoint

Behavior and evidence source `0f460d95e2e56a98aadac7ac76480a8697ef08f7` was sealed by `179402b` in a source-candidate manifest (`sha256=730f6da8e4a08c17be0bef3009da8a596e0693aaaa562f522a146d8f47599d76`). Its components are marked `unbuilt`; both production design flags are `off`. Pack validation passed **769 checks / 0 warnings / 0 failures**. Manifest verification and the release-gate negative controls passed **6 tests** on the clean seal. The exact-candidate assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. This is a checked source checkpoint, not a deployed or admitted product.

This does not finish R21. Calls still lack a stable hash-bound logical identity and provider reconciliation by request ID; other direct adapters and evaluation scripts still need the same policy and durable budget admission. No killed provider process, actual bill, production canary, or clean-host restore was tested. The R21 work item remains in progress and production flags remain off.

## Second pass: a recorded paid reply cannot be repeated after a stage crash

A separate red test simulated a worker death after a successful generated-art call was recorded but before `laying_out` advanced. The old resume path reached stage execution again. The active-run preflight now holds a current-stage `ok` call, or a billed `error`, for review instead of repeating that stage. It recognizes art ledger entries as part of `laying_out`; a completed call from an earlier stage does not become a global hold. An unresolved call from any stage remains blocked under the first pass.

The focused ledger file passed **4 tests** after the red failure. The corrected full source suite passed **420 files / 3,205 tests**, with **4 files / 48 tests skipped**. Workspace/test TypeScript, lint and the zero-secret scan passed. The final clean source-candidate manifest and pack check identify this second pass when sealed. This is a conservative stop, not response replay: a stable logical-call key, persisted response, concurrent cross-Core admission, provider reconciliation and a killed-worker drill remain open. R21 remains in progress.

## Third pass: budget persistence must not erase a paid success

A red test made a provider return a valid billed response, let the call ledger finalize as `ok`, then failed the separate run-budget write. The old shared `catch` ran a second `finalizeCall` with status `error` and zero cost; the test saw two finalizations and failed. The provider failure handler now covers only the provider request for text, structured text and generated art. A later ledger or budget write error propagates without turning a paid provider success into a free failure. If the success finalization fails, its earlier pre-dispatch `uncertain` row is still a hold. The focused ledger file passed **5 tests** after the change.

The first broad suite had one unrelated Desk timing assertion fail while **3,211 tests passed**. That Desk file passed **23 tests** in isolation; a second broad run passed **421 files / 3,212 tests**, with **4 files / 48 tests skipped**. Typecheck, lint and the zero-secret scan passed. These are local tests with a fake provider; they do not resolve cross-Core admission, provider reconciliation or the kill-after-send gate. R21 remains in progress.
