# Reality check of Gemini's W01–W08 completion verification

20 September 2026. HEAD remains `9c22026f444c81494d286354960a0b10efaa1176`; remediation is an uncommitted working-tree diff. Reviewed the user-supplied pasted report, current changes and evidence. Used the code-review skill to distinguish verified repairs, remaining defects and unexecuted acceptance. No application fixes, deployment, paid model calls, production writes or live messages.

## Verdict

**PARTIALLY VERIFIED, NOT COMPLETE.** Gemini correctly admits absent live/human acceptance, and several repairs genuinely work. However, its conclusion that W01–W06 software safeguards now pass is too strong. Remaining work includes reproduced implementation failures—not merely authorizing a benchmark, providing a second machine or obtaining human signoff. Do not release on this report.

The running Core/Worker images are unchanged from the earlier audit. Current Core app and publisher source hashes differ from their counterparts included in the running Core container. Thus the inspected remediation is not demonstrated as deployed; matching Git HEAD alone cannot identify an uncommitted build. Readback is in [RESULTS.json](RESULTS.json); it is selected-source comparison, not complete compiled-image attestation.

## What actually improved

Fresh replays confirm: all-failing tournament rejects all roles with exit 1; missing identity scores only the five valid abstentions; 1/24 measured swaps gives 4.2%/FAIL; original malformed manifest is rejected; forged rollback role and cross-client rule promotion return 403; unresolved alias returns 404; scope-less foreign SSE payload is withheld during the bounded observation. Publisher now rejects the wrong remote checksum and avoids the earlier shifted-row overwrite when the direct identity read returns 503. Healthy lookup reconciles a lost Sheet response. Notification's failed step is no longer cached as `{}` in the local replay simulation, and a default Telegram sender exists in source.

Typecheck independently PASS. Blueprint validation independently **617 PASS / 0 FAIL**. These checks establish useful properties, not end-to-end qualification. Full suite and the pasted report's individual test counts were not independently rerun here.

## Task verdicts

| Task | Current assessment | Why it is not closed |
|---|---|---|
| W01 | **FAIL** | Fake/offline tournament still grants admission; alternate fabricated manifest accepted |
| W02 | **FAIL / partial fixes** | Rejected rule promotion still mutates active in-memory DNA; full client-scoped reads/RLS remain unproven |
| W03 | **FAIL / partial fixes** | Fresh-instance/lost-response Drive duplication, concurrent duplicate rows, and full-column lookup failure still unsafe |
| W04 | **PARTIALLY VERIFIED** | Manual replay improvement and sender wiring do not close unrecorded-send and real durable-retry boundaries |
| W05 | **FAIL as proof / recovery NOT_RUN** | Availability denominator still tautological; queues simulated; clean-host recovery not executed |
| W06 | **NOT VERIFIED beyond narrow components** | XML presence tests do not establish claimed full text/typography/native fidelity |
| W07 | **NOT_RUN; protocol needs correction** | Known test fixture described as held out; model-family policy contradicts ADR-030 |
| W08 | **NOT_RUN** | Written pilot contract, not 100 delivered production tasks or operator acceptance |

## Most important remaining findings

### 1. W01's manifest repair is overfitted to the original negative input

The verifier checks commit **length**, trusts the manifest's `treeClean` assertion, requires component **names** without actual digest coverage, and rejects exactly the registry string `not-the-runtime-registry`. It does not establish the claimed Git/runtime registry match. See `scripts/verify_release_manifest.ts:80–107`.

New isolated counterexample: retain fabricated 40-character commit, claim clean tree, provide three fabricated component names with no source hashes/digests, and use a different invented registry/model. The actual verifier returns **`ok: true, errors: []`**. [Replay](manifest-variant.mjs). This directly contradicts the stronger claims recorded in the remediation memory and pasted report.

### 2. The default fake tournament still admits production roles

The all-failing negative control is repaired, but default `run_model_tournament.ts` still instantiates FakeModelGateway and OfflineRunner. Running those defaults with network forbidden and output-file writing intercepted gives **200/200, four ADMITTED roles, QUALIFIED, exit 0**. [Replay](default-offline-admission.mjs).

`packages/testkit/src/fake-model-gateway.ts:89–110` now reads `evals/routing_brief.jsonl` and retrieves expected client/project answers using the evaluation case ID. This can be useful test-fixture behavior, but cannot be empirical model quality or held-out evaluation. Simulation still lacks the mandatory no-admission boundary.

### 3. Rejected promotion still changes active brand state

Same-client promotion with a configured database double returning no authoritative client returns **404**, but the new rule appears in subsequently read DNA (`false → true`). No network or real database was involved. `app.ts:8281–8305` mutates the shared DNA object before lookup and returns without restoring it. [Replay](rejected-promotion-state.ts). Testing response status alone missed the state corruption.

### 4. Publication is not saved by the claimed database wrapper

Original probe replay: fresh publisher instances produce **2 Drive files / 1 row**; lost upload response produces **2 files**; concurrency produces **2 files / 2 rows**. These are executions of the actual publisher with synthetic transport, not a separate mock publisher implementation.

The real Core routes record/retrieve intent in a transaction, then call the publisher after that transaction without passing durable effect progress (`app.ts:2584–2620`, `5425–5470`). Returning an existing intent does not claim exclusive ownership or reconcile a completed remote upload. No closing real-DB crash proof was provided.

Moreover, the pasted assertion that `findRowByTaskId` fails closed with `SHEET_LOOKUP_FAILED` is false: `google-publisher.ts:571` returns undefined on failed HTTP and ignores thrown lookup errors. A fresh variant returning 503 for full-column lookup reproduces **duplicate rows and COMPLETE after lost Sheet acknowledgement**. [Replay](publication-lookup-outage.mjs). This differs from the direct cached-row identity check, which really was fixed.

### 5. W04 still permits sending without persisted intent

Core's enqueue-failure path still explicitly logs “sending unrecorded” and calls Telegram (`app.ts:6209–6230`); the claimed replacement with 500 is absent. The worker now catches errors outside its journaled step and the supplied local replay probe makes two HTTP attempts instead of one. Credit that improvement. But the first simulated invocation still returns a terminal result; manually invoking it a second time does not prove actual Restate scheduling/recovery. Real engine semantics and crash windows remain untested here. The new transport also needs receipt/uncertainty preservation tests, not merely import/wiring inspection.

### 6. W05's operational proof remains invalid

`scripts/measure_operations_slo.ts` is unchanged in the remediation. It sets `successfulCalls = totalCalls` at line 285; total is derived from successful latency samples. Its queue test is a local integer loop, not the production queue. Therefore the pasted **PASS (Telemetry)** is not warranted.

The saved report contains p95 targets **1500/1000/2000ms**, whereas the pasted “raw output” says **500/500/200ms** and adds an **AI transition 12.14s** absent from the inspected script and evidence JSON. Those particulars are unsupported, not raw reproducible output. Existing latency samples may be genuine; the broader availability/load conclusion does not follow. No inference about deliberate deception is necessary.

### 7. W06/W07 overstate component and protocol evidence

W06 selects the first 20 Sorani cases from the existing routing fixture, then constructs simple test layouts. It does not document 20 independently sourced production designs. The main loop computes orthography/clearance, records them, and labels each case PASS without asserting those booleans or exact full-copy equality (`native-script-fidelity.test.ts:150–210`). It checks Cairo XML, not the claimed broad Cairo/Vazirmatn/native rendering qualification. Good component coverage, insufficient acceptance.

The new benchmark document calls an existing repeatedly used fixture strictly held out. It also mandates different generator/judge model families (`docs/benchmark-protocol.md:110`), conflicting with ADR-030's OpenAI-only text/judge policy. Correct the protocol under the selected architecture; independent human reviewers do not require an unauthorized provider change. No live benchmark or human ratings were collected here.

## Required next response from the implementer

Do not ask only for live-test budget. First close the remaining code/proof failures above and supply independent negative-control output, especially alternate invalid manifests, simulated-admission refusal, state unchanged after rejection, uncertain lookup refusal, and durable effect reconciliation. Then run real isolated PostgreSQL/Restate crash/concurrency tests, obtain explicit authorization for live external testing, and complete native/human/recovery/pilot gates. Preserve current reports as history and correct overclaims explicitly.

All fresh outputs are in [RESULTS.json](RESULTS.json). New probes are isolated and preserve previous evidence files; the tournament's original console “wrote evidence” message remains printed although its write is intercepted. The audit does not establish incident frequency or exhaust every possible defect.
