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

## Fourth pass: uncertain results stop degradation, and PostgreSQL admits one logical call

A red art-stage test showed a lost image-provider reply being caught and replaced by a procedural motif, leaving the stage apparently successful although its ledger row was uncertain. The art stage now propagates a hold. The same hold is propagated through directed edits, revision, critique, canary, judge and late-reference rebrief catches; the active run remains at its stage instead of being marked failed or falling back to another paid design. An orchestrator test with isolated PostgreSQL now expects the held `laying_out` run and uncertain call, with no planner fallback. A directed-edit timeout test expects the same hold and no fresh layouts. ADR-048 records this corrected behavior.

The cross-Core race test used two independent PostgreSQL handles. Before the change, both inserted different pre-dispatch rows for the same next call (**2 admitted**, test failed). Migration `028_studio_call_admission.sql` adds a positive per-run ordinal, a SHA-256 logical-call digest and two uniqueness indexes. The repository inserts the identity before dispatch; a collision returns `MODEL_CALL_ADMISSION_CONFLICT`. The Core wrapper hashes run/stage/provider/model/ordinal and canonicalized request input, so reordered object keys retain one identity. A service negative test confirmed a losing admission sends **zero** additional provider requests. Parity checks use a content identity without an ordinal because completed runs cannot update their budgets. The authorized evidence endpoint exposes call ID, ordinal, digest, provider response ID and status metadata without storing or returning the prompt.

The first broad run after adding migration 028 found **10 failures in 5 files**: two obsolete fallback/failed-run expectations, one of which caused five downstream tenant-cap failures; two latest-migration lists named 027; and the dirty-tree release-manifest control refused as designed. After correcting those tests, the source suite excluding the manifest-dependent release-gate file passed **420 files / 3,209 tests**, with **4 files / 48 tests skipped**. Focused stage/ledger/database controls passed **3 files / 30 tests**; the four affected orchestrator/directed/schema files passed **49 tests**, and the evidence route passed **23 tests**. Typecheck, lint and the zero-secret scan passed. The exact clean-candidate full suite and release assessor are checked after sealing.

This is database-backed admission, not provider idempotency. It does not reconcile an accepted request with a lost answer, persist a replayable response body, fence all candidate/run mutations across Core processes, or prove a killed provider process and clean-host restore. Historical rows lack the new identity. R21 remains in progress; production flags remain off.

### Sealed fourth-pass source verification

Behavior, tests and evidence source `ce474be2361c5629e2d2b57d07502bffa0eb5302` was sealed by `3abc972` with release-manifest SHA-256 `f37feeb4cced1c5d7a13820e21b4cba7ca457b5380c4a8856dc845e4ef30e717`. The exact sealed suite passed **421 files / 3,215 tests**, with **4 files / 48 tests skipped**. Typecheck, lint, zero-secret scan and blueprint **771 checks / 0 warnings / 0 failures** passed. A manifest verification launched concurrently with the full suite refused transient test-time working-tree changes; after the suite exited, the tree was clean and manifest verification passed. The six release-gate controls passed separately on that clean tree. The exact source assessor returned `UNQUALIFIED_ENGINEERING`, with Gates A–H each `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest labels build components `unbuilt`; neither design flag was enabled. This is a source checkpoint, not a deployed release.

## Fifth pass: process killed after model request bytes reached a local provider

An isolated PostgreSQL drill starts a real child Core process running `DesignStudioService.resume`. The child sends a Studio text request to a local HTTP fake provider. The parent waits until the provider has read the complete request body, deliberately withholds the response, and kills the child with `SIGKILL`. The committed call row remains `uncertain` with ordinal 1 and a SHA-256 logical-call identity. A fresh PostgreSQL handle and Core service then reject resume with `MODEL_CALL_UNCERTAIN`; its fetcher is not called, and the fake provider has received exactly one request. The focused drill passed **1 file / 1 test**. This is a process-kill test at the send boundary, beyond an exception-only simulation.

The local provider's complete read establishes receipt of bytes by the fake endpoint, not billable acceptance by a real provider. This drill does not reconcile a real provider request ID, recover on a clean host, persist a replayable provider response, or fence all stage/result writes across Core instances. R21 remains in progress and design flags remain off. The broad source suite excluding the manifest-dependent release-gate file passed **421 files / 3,210 tests**, with **4 files / 48 tests skipped**. Workspace/test TypeScript, lint and the zero-secret scan passed. Blueprint hashes are refreshed after this evidence is committed; the exact clean-candidate gate is checked after sealing.

### Sealed fifth-pass source verification

Source and evidence commit `2f9cb4e6920f156cde17e9fb7d311599c6a42b9b` was sealed by `6d07d26` with source-candidate manifest SHA-256 `cd70a83a9cf8af30ecf8cc174b7a1169f8b48521c7596bc50cec50bfab006d3e`. The clean sealed suite passed **422 files / 3,216 tests**, with **4 files / 48 tests skipped**. Manifest verification, blueprint **771/0/0**, and the six release-gate negative controls passed. Typecheck, lint and the zero-secret scan passed before the seal. The exact source assessor returned `UNQUALIFIED_ENGINEERING`, with Gates A–H each `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest labels build components `unbuilt`; both design flags remain `off`. This is a verified source checkpoint, not a deployed or quality-admitted product.

## Sixth pass: kill Core after a paid reply is recorded but before stage completion

The second real-child drill lets the local fake provider answer a Studio text request with a valid billable response. A separate PostgreSQL transaction holds the run row with `FOR NO KEY UPDATE`, which permits the call ledger's foreign-key check but delays the subsequent run-budget write. The parent observes the ledger row finalized as `ok` with positive estimated cost, kills Core with `SIGKILL`, then releases the row lock. A new database handle and Core service refuse resume with `MODEL_STAGE_REPLAY_UNSAFE`, issue no second fetch, and the fake provider has received one request. An initial harness attempt used `FOR UPDATE`; it blocked the call insert itself, so the test saw no call. The weaker lock made the intended post-ledger boundary reachable. Both process-kill cases then passed **1 file / 2 tests**.

This proves that the existing recorded-paid-call hold survives an actual Core process death at this local boundary. It does not persist the response body for automatic stage recovery, prove real provider billing, or reconcile unknown acceptance. R21 remains in progress. The broad source suite excluding the manifest-dependent release-gate file passed **421 files / 3,211 tests**, with **4 files / 48 tests skipped**. Workspace/test TypeScript, lint and the zero-secret scan passed. The exact clean-candidate gate follows after sealing.

### Sealed sixth-pass source verification

Source and evidence commit `c7bfd373442381d087e38408cf90b8a913fe4de4` was sealed by `7901d80` with source-candidate manifest SHA-256 `e942b4ef3dc8020e0eebe2b2457f1f55c0f1eb099b49fe11dcc873024af6ddf0`. The clean sealed suite passed **422 files / 3,217 tests**, with **4 files / 48 tests skipped**. Manifest verification, blueprint **771/0/0**, and six release-gate negative controls passed. Typecheck, lint and the zero-secret scan passed before the seal. The exact source assessor returned `UNQUALIFIED_ENGINEERING`, with Gates A–H each `NOT_RUN_DEPLOYMENT_REQUIRED`. Build components remain `unbuilt` and both design flags `off`. The local paid-reply hold is verified; R21 and product admission remain open.

## Seventh pass: retain provider receipt provenance without private response content

ADR-050 and migration 029 add nullable served-model, provider request-header ID, output SHA-256, latency and attempt fields to the tenant-scoped Studio call ledger. Text-call finalization writes the model actually reported by the provider and its existing receipt facts with status/cost; generated art writes available receipt facts without calling a procedural fallback a provider-served model. Historical and unavailable fields stay null. The authorized run evidence route now distinguishes requested `model` from `servedModel` and exposes these non-content fields. The older `response_id` can be locally synthesized by an adapter when no provider ID arrives, so the separate `provider_request_id` is the trusted request-header field. No raw prompt, text answer or image bytes were added to the ledger.

The isolated database test checks new facts survive finalization and remain immutable. The route test checks their authorized shape without response content. The recorded-reply process-kill drill now uses different requested and served model names and a fake `x-request-id`, then checks the exact output hash and receipt metadata in the durable ledger before killing Core. Focused **5 files / 43 tests** and workspace/test TypeScript passed. This improves evidence for provider reconciliation; it does not itself query the provider, prove billing, or persist a replayable answer. R21 remains in progress; broad and exact-candidate checks follow after source sealing.

A further red test showed a structured tool-call answer parsed correctly while `rawText` and the receipt SHA-256 described the empty message-content fallback (`{}`). The client now hashes and returns the actual parsed tool payload or tool-call arguments. That file failed **1 of 19 tests** before the correction and passed **19 of 19** afterward. This matters because a digest of the wrong bytes would make the new ledger provenance misleading. The final broad run includes this correction.

The corrected broad source suite excluding the manifest-dependent release-gate file passed **421 files / 3,213 tests**, with **4 files / 48 tests skipped**. Typecheck, lint and zero-secret scan passed. The negative traceability control and all **105** exact `TEST-<requirement_id>` mappings passed. The clean-candidate manifest and admission controls are checked after the source commit.

### Sealed seventh-pass source verification

Source and evidence commit `af910c88267da28b9d637c5c431906375d49b3e0` was sealed by `9cd65e1` with source-candidate manifest SHA-256 `41a72f2ca92f4a00052d31340516d29243187b6e6dbe605379ff627ae560e26c`. The exact clean suite passed **422 files / 3,219 tests**, with **4 files / 48 tests skipped**. Typecheck, lint, zero-secret scan, blueprint **773/0/0**, manifest verification and six release-gate negative controls passed. The exact assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest records migration 029, `unbuilt` components and both design flags `off`. Provider-side reconciliation, policy-governed response persistence, full stage fencing, clean-host recovery and quality admission remain open.

## Eighth pass: seal pending identity and first uncertain outcome

ADR-051 and migration 030 close an integrity gap in the paid-call ledger. Its old trigger protected `ok` and `error` rows but allowed a pending call's run/stage/model/ordinal/digest to change, and allowed a finished `uncertain` outcome to be rewritten. The new trigger fixes identity at admission, requires any pending-row update to record `finished_at`, and seals that first outcome regardless of status. Repository finalization compares against `finished_at IS NULL` and raises `MODEL_CALL_FINALIZATION_CONFLICT` if the call is missing or has already finished. The Studio treats that conflict as a hold instead of falling back or starting another design path. No raw model output is stored.

An isolated PostgreSQL test checks pending identity and cost cannot be silently changed, an `uncertain` first outcome remains unchanged, and both repository and direct SQL attempts to replace it fail. A Core wrapper test checks a provider reply followed by a finalization conflict makes one provider request and propagates the hold. The affected **4 files / 25 tests** passed; workspace/test TypeScript passed. This is local integrity proof. Provider-side reconciliation, response persistence, complete stage fencing, clean-host recovery and production admission remain open; R21 stays **in progress** and design flags stay off.

The source suite excluding the manifest-dependent release-gate file passed **421 files / 3,215 tests**, with **4 files / 48 tests skipped**. Lint and the zero-secret security scan passed. The exact sealed-candidate result is recorded after the source commit and release manifest are made.

### Sealed eighth-pass source verification

Source and evidence commit `5911e81d17416a95ce48bcd54dc108bd7f45931d` was sealed by `ef8067015714d32905a742a608f1a34c19fe7bcb` with source-candidate manifest SHA-256 `013dc7a41f870c16decfb1bd1fae6c26fcd4ca0bba4f646709a61121ff32988c`. The exact clean suite passed **422 files / 3,221 tests**, with **4 files / 48 tests skipped**. Typecheck, lint, zero-secret scan, blueprint **775/0/0**, manifest verification and six release-gate refusal controls passed. The assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. Migration 030 is recorded in the manifest, build components remain `unbuilt`, and both design flags remain `off`. Provider reconciliation, response replay, complete stage fencing, clean-host recovery and quality admission remain open.

## 2026-09-27 — Shared gateway and evaluation uncertainty hold (ADR-083)

The shared gateway now stops after network/timeout uncertainty, HTTP 408/5xx,
unreadable or unusable successful output, schema failure or observed model
mismatch. A later provider cannot conceal the earlier acceptance or bill. Errors
retain bounded provider receipt facts and unknown cost without private response
content. Explicit rate rejection still permits an authorized bounded fallback;
valid JSON null/false/zero is a completed answer, never a reason to call again.

The evaluation runner stops further routing and visual model calls on that hold,
reports attempted and unexecuted cases separately, and leaves aggregate pass rate
null. Desk labels the run stopped and suppresses even an obsolete stored 100%.
This is an in-process safeguard; evaluation reports still lack a durable call
ledger and restart reconciliation. Studio's separate persistent ledger does not
cover these evaluation calls.

Original regression: 28 failed/1 passed. First gateway follow-up: 45 passed/1 failed;
the old multimodal-header fixture sent a Google response to Anthropic before
falling through and now explicitly selects Google. Final connected checks:
17 files/131 passed/zero failed/zero skipped, including a real localhost response
lost mid-body with one observed request. Project/script/test types, lint and Desk
build passed. Earlier failed receipts are retained. No full-suite rerun or rebuilt
app candidate belongs to this slice; the earlier 3,687-test result and isolated
8dd04cc candidate remain historical. No paid model call, production change,
human approval or message occurred. R20/R21 remain in progress.

Proof: `plans/research-grade-upgrade-2026-09-25/R21_GATEWAY_HOLD_PROOF.json`.
Next: durable evaluation admission/recovery and candidate verification, followed
by the real named-review/edit/revision/delivery pilot, independent recovery and
held-out quality/cost qualification.

Initial pre-commit scanner rejected a synthetic response marker named secret. Renamed it privateBody without changing runtime behavior or the marker value; the gateway follow-up passed 41 tests, zero failures. Final acceptance of the commit hook is checked separately.
