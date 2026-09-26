# R20 — Model egress and execution-truth slices

**Date:** 2026-09-25. **Status:** in progress. **Sources:** gateway/guard `3364a21` (evidence `b95914f`, seal `2bdc493`); voice boundary `4f7dd8e` (evidence `5817db6`, seal `2577153`) on `codex/research-grade-design-system`. **Requirements exercised:** FR-056, FR-065, FR-066, FR-067, NFR-007. Linked contracts: `docs/07_MODEL_REGISTRY_AND_EVALUATION.md`, `docs/14_SECURITY_THREAT_MODEL.md`, `MASTER_SPEC.md`.

## Failure and change

Three new negative tests first failed. A policy-governed request whose only allowed cloud provider had no credentials returned a synthetic success labeled with that cloud model. An empty allowlist acted like permission to try every provider. The embedding and reranking adapters returned fixed vectors/scores while claiming Qwen invocations. Those are false execution and quality receipts.

The gateway now rejects an empty provider allowlist, filters every fallback candidate against an explicit allowlist, skips cloud candidates without credentials, and permits deterministic fallback only as an identified local deployment. Cloud candidates cannot silently execute the local heuristic and keep a cloud label after an empty response. The unwired embedding and reranking methods return `LOCAL_MODEL_UNAVAILABLE` rather than fabricated results. The old resilience tests use explicit fake provider HTTP responses, so their provider, attempt, circuit and cost assertions still exercise the real dispatch path; production source has no `NODE_ENV` test branch.

The repository egress linter scans `apps/*/src` and `packages/*/src`, detects literal provider endpoints and direct SDK imports, and no longer skips a production file merely because its name contains `test` or `fixtures`. Its regression tests prove these cases. Nine existing direct-call files remain explicit exceptions, so a passing lint is a migration ratchet, not proof that all calls use one policy.

## Verification

- Initial focused negative run: **3 failed / 1 passed**; it showed the fabricated cloud result, empty allowlist escape and fabricated local model calls. The full suite then found and rejected a test-only production branch; that branch was removed.
- Focused controls passed **4 files / 24 tests**, including the no-test-backdoor control. The full suite passed **408 files / 3,073 tests** with **4 files / 48 tests skipped**. After that full run, the commit security hook required only a fake-key construction change in a test; the two affected gateway test files were rerun and passed **17 tests**. No production code changed after the full run.
- Application and script TypeScript checks passed. Egress lint passed with **9 named existing exceptions**. Blueprint validation passed **741 checks / 0 warnings / 0 failures** on the evidence tree after manifest refresh. The commit security scan passed. The clean source-candidate release manifest generated from `b95914f` was committed in `2bdc493` and verified on the clean tree; its components remain labeled `unbuilt`.
- Network-negative tests now mock `fetch` for policy-governed text, image metadata and audio metadata. They show zero external requests through `ResilientModelGateway`; they are **not** a seeded end-to-end task with real photo and voice ingestion.

## Second slice: unresolved voice audio does not leave the office

The `KurdishVoiceTranscriber` sent audio to OpenAI whenever a key was present, before Telegram intake knew the client's egress policy. A red negative test attempted one OpenAI request with a fake key and synthetic bytes; the provider returned 401. The test was then changed to mock `fetch` so the subsequent verification could never send real network traffic. The adapter now requires an internally supplied client UUID, `client_voice` data class and explicit external-provider allowance before a cloud call. Missing or `local_only` decisions produce `audioStatus: policy_blocked` and no model request; an authorized fake HTTP response still proves transcription can execute. This object is a boundary input, **not yet a database-backed proof of client authorization**.

The standalone `/assets/transcribe-brief` route has no locked client scope, so uploaded audio returns 412 before the adapter. Telegram intake with actual audio and no verified policy records the update as held, asks the sender for the full brief as text and creates no partial task from a caption. A caption on a message whose audio was not available can still be processed as text, but is no longer reported as a voice transcript. This deliberately reduces automatic voice capability until scope resolution is wired in; it prevents an unknown client's spoken instructions from being silently omitted or sent externally.

One Core route test initially imported a stale built integrations package, even though the adapter's direct source test passed. After rebuilding `@hawa/integrations`, the route-level red test reproduced the 200 response and the new 412 control passed. The first rebuilt full run found two historical tests that relied on fabricated cloud output: failover and a claimed 95% uncredentialed tournament. Failover now uses an explicit fake Anthropic HTTP response; the uncredentialed tournament records failure and remains admission-ineligible. The final rebuilt-package full suite passed **408 files / 3,076 tests**, with **4 files / 48 tests skipped**. `pnpm typecheck` passed source, scripts and included test types; egress lint passed with 9 existing exceptions; pack validation passed **741 / 0 / 0**. Focused voice/Core controls passed **3 files / 17 tests**.

The clean source-candidate manifest generated from evidence commit `5817db6` was sealed in `2577153` and verified. It identifies source and unbuilt components; it is not a deployed-image receipt.

R20 remains **in progress**. No production caller yet supplies a trusted database-resolved voice decision, so actual voice notes require a text resend. The model gateway, planner, image, evaluation and voice paths still lack one verified scope/data-class/budget decision; the nine direct-call exceptions and unknown paid-call accounting remain. A seeded local-only text/photo/voice task and live network-deny drill have not run. No production flag or deployment changed.

## Third slice: unscoped Telegram text remains local

**Source:** `82b2898` (2026-09-25). `classifyInboundTelegramMessage` previously sent the sender's text, recent design copy and sometimes its preview to OpenAI whenever a key existed, before a locked client policy was resolved. The classifier now requires an internally supplied client UUID, `client_message` data class and explicit OpenAI allowance before this call. No production caller supplies such a decision yet, so Telegram intake uses local rules by default. A typed decision is a boundary input, not proof that a database-backed client authorization was checked.

The first full run after blocking the model found three behavior regressions: a photo-only album reply lost its first picture's change, and two short messages under a recent design no longer asked whether they were new work or a revision. The local path now recognizes a captionless photo replying to a draft as feedback, and pauses a short unstructured message for an explicit new/revise answer. A separate local rule now reads “please make the title gold” under a recent design as feedback rather than a new brief. These rules use the existing question/album persistence paths and do not make a provider call.

Focused classifier and webhook checks passed **3 files / 67 tests**, including key-present, no-policy and local-only cases, mock-network denial, a multi-photo revision and both clarification replies. After those corrections, the full source suite passed **419 files / 3,126 tests**, with **4 files / 48 tests skipped**. Full workspace/test TypeScript checks and the egress lint passed; the lint still lists nine direct-call exceptions. The initial broader run had **3 failing tests** and is not passing evidence.

**Limit:** This protects only this Telegram text-classification call. It does not prove all client text/photo content stays local, that a supplied decision was derived from a locked client, or that the local classifier matches the model's accuracy across real multilingual messages. Model-assisted routing stays unavailable until client policy resolution, scoped budget and trace receipts are wired in and separately evaluated. R20 remains in progress.


## 2026-09-27 — Voice candidates preserve evidence and unread audio cannot become work

ADR-074 corrects a prerequisite for source-review admission. The adapter previously
mixed captions into transcripts, rewrote spoken prices, assigned fixed confidence
0.96 and language ckb, and substituted a made-up duration. Provider response reads
were unbounded and error logs could contain private response/transport content.
Legacy Telegram intake could still create a design from a caption when audio was
unavailable. The earlier caption-only allowance in this file describes superseded
behavior; all voice sources are now held before download in that legacy path.

Provider text is retained exactly, supplied text is separate, unknown measurements
are null and caller duration is explicitly labeled. No automatic price normalization
or inferred campaign objective is used as source evidence. The existing standalone
endpoint inspects exact supplied text, validates its shape/size, requires copy review
and refuses audio with 412. The adapter reports not_sent/rejected/received/uncertain,
makes one HTTP request at most, bounds audio/response/text, refuses redirects and
bounds stalled response reads without awaiting broken cancellation. Error bodies and
thrown provider errors are not logged. Unknown acceptance never becomes a success.

Red-before: **22 failed / 1 passed**, including stalled-body/error-body timeouts.
The initial sandbox run could not connect to the isolated database and executed no
tests. The negative-size fetch spy initially delegated to native fetch with synthetic
bytes and a synthetic key; it now rejects explicitly, and all final provider fixtures
are mocked. Final affected regression: **5 files / 55 tests passed**. Source, script
and included-test types and lint passed. Full release regression is pending the new
seal. Exact file hashes and results: `R20_VOICE_EVIDENCE_PROOF.json`.

This is an adapter and unsafe-intake correction, not completed voice admission.
Retained audio, current locked client policy, model/cost admission, durable paid-call
reservation/outcome, reviewed-source handoff and process-crash proof remain next.
Unknown outcome flags are not a substitute for PostgreSQL reconciliation. Real
multilingual transcription accuracy has not been measured. Production is unchanged.
