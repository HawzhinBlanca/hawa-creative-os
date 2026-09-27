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
and included-test types and lint passed. Sealed source `a03f2fb` / seal `d19abb6`: **445 files / 3,498 tests passed**,
with **6 files / 58 tests skipped**, in 98.16 seconds. Blueprint **855/0/0**,
zero-secret scan and release manifest verification passed. No live transcription
or voice process-crash admission is claimed. Exact file hashes and results: `R20_VOICE_EVIDENCE_PROOF.json`.

This is an adapter and unsafe-intake correction, not completed voice admission.
Retained audio, current locked client policy, model/cost admission, durable paid-call
reservation/outcome, reviewed-source handoff and process-crash proof remain next.
Unknown outcome flags are not a substitute for PostgreSQL reconciliation. Real
multilingual transcription accuracy has not been measured. Production is unchanged.


## 2026-09-27 — Retained voice, reviewed copy and durable paid admission

ADR-075/migration 044 extends the existing source owner to bounded Ogg Opus voice.
The client is fixed before download; original bytes and locally inspected timing
are retained. Current approved Client DNA, client privacy and an admitted versioned
voice model with explicit cost limits govern one durable reservation per
tenant/client/audio hash. The first outcome is immutable. Restart or duplicate
audio cannot repeat a paid call; missing outcomes remain uncertain. Exact requester
copy creates one new request or current revision, and Desk exposes the original and
full escaped, unreviewed transcript with reserved estimate and unknown actual cost.

The first paid-path run failed four tests because `FOR SHARE` also applied model
update RLS. A narrow role-checked definer reader locks eligible models without
granting model write access. One later failure exposed four missing route-inventory
entries. The final affected run passed 184 tests and failed one malformed generated
duration fixture; its corrected 13-test domain follow-up passed, including the
600/601-second boundary. All **185 distinct affected tests across 13 files** have
passing final observations. Source/test types, lint and Desk build passed.

The actual Core crash drill passed **40 invariants**, with **five SIGKILLs, six
starts, four original downloads and two synthetic transcription requests**. Three
paid attempts retain one completed outcome; the two missing outcomes are not
retried. A policy revocation before paid admission prevents the request. New and
revision copy, no duplicate task/outbox, daily-limit concurrency, and client-access
revocation have separate PostgreSQL tests. No actual provider service was used.

Live multilingual speech accuracy, billing reconciliation, an isolated deployed
canary, the complete real Canva journey, retrieval measurements, clean-host recovery
and human creative review remain open. Manual copy does not settle uncertain
billing. R07/R12/R20 remain in progress. Proof: `R07_VOICE_RECOVERY_PROOF.json`;
operation: `runbooks/REQUEST_SOURCE_REVIEW.md`. Final sealed regression is recorded below.

First sealed full run (`aaa5ff7` / `3bf53ea`): **3,527 passed, one failed,
59 skipped**. The task-status drift test mistook the independent voice outcome
`received` for a task enum. It now recognizes the task-specific review states;
complete generated declarations and deliberate drift checks remain. Its focused
follow-up passed **18/18**. The failing full run is not release acceptance.

**Final sealed regression:** source `d92014c` (implementation `aaa5ff7`), tested
seal `0621da8`: **447 files / 3,528 tests passed**, **7 files / 59 tests skipped**.
The opt-in voice kill drill passed separately with 40 checks as above. Typecheck,
lint, Desk build, zero-secret scan, blueprint **859/0/0** and sealed manifest pass.
Production containers reported healthy on read-only inspection; this candidate has
not been deployed and no model/flag/admission changed. Next is the isolated complete
app candidate and real Canva/source/recovery/human qualification.

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

## 2026-09-27 — Durable fixture evaluation replay and recovery (ADR-084)

Migration 047 and the existing evaluation tables replace Core's in-memory history.
A stable Desk action UUID admits one tenant-scoped run; a changed name conflicts.
Each model request is recorded before transport. Completed calls replay an
allowlisted scoring projection and receipt metadata; raw prompt/free-text output
is not stored. Corpus, visual image, evaluator protocol and source seal bind replay.
Database loss starts no fallback work, and a new action cannot bypass an incomplete
run or pending/uncertain call. The call admission and first outcome are immutable.

Desk retains a failed HTTP action through refresh, offers resume on incomplete
history, and exposes observed provider/model facts, estimated costs and unknown
amounts. Fixture diagnostics remain admissionEligible:false. Recovery checks the
saved admission before current provider availability, so removing a provider cannot
skip an earlier uncertain call.

Connected checks: 23 files/181 passed, zero failed/skipped; final affected follow-up
4 files/14 passed including the new version-mismatch refusal. Two real SIGKILL
boundaries each observed one localhost provider request: the missing answer stays
held with no replay fetch; a committed reply is reused and subsequent never-admitted
calls can proceed. Runtime-RLS tests also cover tenant isolation, concurrency,
immutable outcomes, HTTP retry/fresh Core history and a database failure before the
next admission. Types, lint and Desk build pass. The initial typecheck's two missing
safeAction fields were corrected. Full regression and refreshed candidate follow
source sealing; earlier source/candidate results do not qualify this migration.

Provider billing lookup/settlement, independent-host recovery, the real named-review
Canva/revision/delivery pilot, and human quality/cost qualification remain open.
No production change, real model call, human approval or message. R20/R21 remain
in progress. Proof: `R21_DURABLE_EVALUATION_PROOF.json`;
operation: `runbooks/EVALUATION_RECOVERY.md`.

### Candidate packaging and full-regression correction

Initial sealed candidate 448c79c passes 36 synthetic workflow invariants, but its
evaluation POST returns503 before any provider call: the image omitted the three
root fixture files and RELEASE_MANIFEST.json. The retained file-existence/HTTP
negative control proves all four omissions and zero fake-provider calls. The
Dockerfile now copies only those required resources and evaluates the replay
identity during image build. The probe's first fake-ledger URL was wrong; it was
corrected before that measurement.

First full regression: **3,739 passed, six failed, 59 skipped**. The failures are
explicit old migration/table/policy counts and an old expectation that evaluation
history exists without PostgreSQL. Corrected checks require migration047,55 base
tables/27 policies, and503 without storage; they also assert the new ledger/table
policy by name. Base RLS now covers the ledger before versioned migrations too.
The schema text check is explicitly labeled as inventory, not a recovery drill.
Affected follow-up: **8 files/33 passed**, including runtime RLS and both actual
process-kill cases. Final full regression and corrected image checks follow.

### Final full regression and deployed evaluation proof

Packaged source2d1e56b, sealed candidate34d10d5: **3,745 tests pass, zero fail,
59 are skipped**. The rebuilt candidate passes36workflow invariants and14additional
evaluation controls. Its one synthetic Google request receives a held failure;
Core restarts, the same action returns the identical saved report, and fresh or
changed actions cannot bypass that outcome. Call details retain unknown cost and
observed provider facts without saved model output. Image source labels agree.

A final CSS-only follow-up pins the evaluation panel to its right-hand grid cell:
opening the full-width call-receipt section must not move it into the narrow
sidebar column. The Desk build passes; the full regression above covers the prior
layout and unchanged runtime logic. A final candidate refresh follows this visual
layout correction. Production and real provider/approval/quality admission are
unchanged and unqualified.
