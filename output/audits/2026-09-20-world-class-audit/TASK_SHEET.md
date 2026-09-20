# Proof-gated route to a genuinely excellent Hawdesign

20 September 2026 · Audit baseline `9c22026f444c81494d286354960a0b10efaa1176`

This is a proposed task sheet, not authorization to deploy, spend, modify production data or fill in human ratings. All tasks below are **OPEN / NOT IMPLEMENTED BY THIS AUDIT**. Reopen affected September 19 R01–R14 claims; preserve their historical reports with explicit supersession rather than silently rewriting history.

## Execution contract

Keep the selected Canva/PostgreSQL/Restate architecture and ADR-030 model policy. Before changes, map exact requirement IDs through `plans/traceability.csv`, read their normative sources and preserve MASTER_SPEC invariants. Use complete vertical slices, not another collection of partially connected modules. Do not add a framework, provider or new storage service without an independently measured need and required ADR.

Every task must provide: audited commit and built image digest; model/prompt/tool/data/config versions where relevant; reproducible command; exact environment; expected versus actual output; all failed attempts; raw logs/receipts with secrets removed; and evidence hashes. Status vocabulary: PASS, FAIL, NOT_RUN, BLOCKED, NOT_APPLICABLE_WITH_REASON. Simulated tests must say SIMULATED and cannot confer live qualification.

## W01 — Make the proof system capable of saying no

**Priority:** release blocker. **Owner:** implementation agent plus separate reviewer. **Maps to:** R01/R10/R11; Gates D and release integrity. No dependency.

Derive tournament admission and release status from complete checks; separate offline/component/live modes. Require client/project/brief fidelity and all expected measurements. Include failed requests in operational denominators. Remove qualification on skipped tests. Preserve all audit negative controls as regression tests. Bind evidence to actual build, component image digests, migrations, flags and resolved model/tool configuration. Actual deployment must enforce refusal, not merely log failure.

**Required proof:** independently inject failure/absence into each predicate. Every one refuses admission/deployment with a nonzero result. Wrong commit, dirty or undocumented build, empty/incomplete manifest, stale model registry, changed prompt, skipped tests, missing case IDs and all-failing tournament must never QUALIFY. Rebuild current integrity metadata through its generator and rerun validation. Do not “fix” failing checks by excluding audited files or weakening assertions. Test the deployment refusal path in an isolated environment, not against production.

## W02 — Enforce actor and client scope at every entry point

**Priority:** release blocker. **Owner:** implementation agent; independent security reviewer. **Maps to:** R03/R04; Gate B. Can proceed alongside W01.

Derive role/identity only from authenticated principal. Bind candidate rules, snapshots, Studio runs, evidence/images, streams and mutations to permitted client/project scope. Resolve UI aliases explicitly within scoped database transactions; refuse missing/failed persistence. Make authoritative revisions database-allocated and append-only; require expected version at conflicting updates. Reassess bearer-in-URL/browser storage and revocation within the actual single-office threat model, without adding public-SaaS scope.

**Required proof:** rerun operator-role forgery, cross-client promotion, metadata-free SSE, alias lookup and DB failure probes. Then use real isolated PostgreSQL RLS roles and two fresh processes for concurrent edits/restarts. No false 2xx on failed persistence; no cross-client read/write/event; no historical revision overwritten. Show exact rejected requests and unchanged unrelated records. Review against applicable OWASP ASVS requirements; missing checks stay open.

## W03 — One durable publication and approval boundary

**Priority:** release blocker. **Owner:** backend/integration agent. **Maps to:** R05/R06; FR-041/044–050/060, NFR-014/020; Gates C/F/G. Depends on W02's authoritative identity/state.

Require committed immutable publication intent before remote effects. Consolidate both entry routes around durable progress. Resume and reconcile remote IDs after restart or uncertain results. Never overwrite a Sheet row without reliable identity; distinguish unavailable search from no match and honor destination tab. Enforce source revision→binding/capture→export set→passing QA→approval lineage transactionally. COMPLETE requires remote content, destination and access verification.

**Required proof:** fault at every remote-call/receipt boundary; fresh-process and concurrent replays; Drive/Sheets accept then drop reply; moved/sorted/deleted rows; failed identity reads; duplicate IDs; wrong checksum/parent/access; multi-file partial success. Independently enumerate remote artifacts and compare unrelated sentinel rows before/after. One logical delivery converges, no unrelated mutation, no invented receipt. Stale capture A cannot be approved against revision/QA B. Start with isolated transport; live test workspace requires explicit approval and bounded cost.

## W04 — Complete the terminal-notification workflow

**Priority:** release blocker. **Owner:** workflow agent. **Maps to:** R07; FR-051/060, Gate C. Can proceed alongside W03.

Register and test the real production outbox transport. Do not swallow pre-enqueue Core failures inside a successful durable step. Make intent acceptance durably retryable without regenerating design work. Do not send when required intent storage fails. Model ambiguous external acceptance explicitly; do not promise physical exactly-once Telegram delivery.

**Required proof:** exact production consumer configuration handles Core unavailable, DB enqueue failure, returned 429, process death after remote acceptance, malformed response and photo failure. Observe eventual confirmed sent or actionable uncertain/dead-letter state with original message IDs. Demonstrate replay never reruns paid generation. A pending row alone is not successful recovery.

## W05 — Recover the whole office, and measure real operations

**Priority:** before unattended use. **Owner:** operations implementer plus independent drill observer. **Maps to:** R09/R12, Gate H and documented NFRs. Requires W03/W04 semantics.

Choose independently accessible off-host recovery storage and key custody; remove committed encryption fallback; test backup integrity, retention and inaccessible/missing-key cases. Recover actual database contents, editable assets, configuration and durable workflow state. Measure request failure/latency and end-to-end delivery over all eligible events; exercise the specified workload/concurrency with resource and queue telemetry.

**Required proof:** owner-approved clean-host drill from a replica that survives loss of the original host. Establish a disaster cutoff and measure actual lost acknowledged work, not backup duration. Verify RPO≤15 minutes and RTO≤4 hours through usable application plus in-flight reconciliation. Include older snapshots, corruption and partial backup. Show human-readable recovery steps and restored user journeys. Load tests show all errors, p50/p95, capacity, bounded queues and recovery; a short test is not monthly availability evidence. Do not run the current drill casually—it writes a marker to its configured source database.

## W06 — Prove editable native-script fidelity

**Priority:** creative-release blocker. **Owner:** creative integration agent plus native-script reviewer. **Maps to:** R08/R13; Gates A/E/F. Requires stable W01 provenance.

Use canonical protected copy, logos, fonts and layout structure throughout. Keep deterministic correctness separate from aesthetic preference. Expand approved client exemplars only through explicit provenance and human selection; do not mix generated outputs into reference truth without labeling them.

**Required proof:** normative 40 synthetic plus 20 real Sorani cases through native Canva import→edit→save→reopen→export, also covering Arabic/English, dense type, tracking, rotation, alpha, shapes and logos. Keep original/preview/export hashes, actual node/text editability checks and native-speaker decisions. XML property tests remain component evidence. Flattened copy, changed facts or wrong logo cannot be compensated by a high aesthetic score.

## W07 — Demonstrate creative advantage, not model self-approval

**Priority:** required for “best” claims. **Owner:** benchmark engineer; independent designers, native-language reviewers and owner. **Maps to:** R10/R13; Gate D and human acceptance. Depends on W01/W06.

Freeze a held-out, representative 200-task model/retrieval benchmark aligned to Gate D. Include genuine clients, formats, dense bilingual typography, references and adversarial facts; keep tuning data separate. Add relevant pinned Graphic-Design-Bench tasks, but do not substitute generic scores for local workload. Compare the current system with the previous frozen/audited release (not presumed qualified) and agreed strong professional/native-template baselines. Prespecify human sample size, margins, metrics, exclusions and budget before viewing outputs.

**Required proof:** real model receipts, complete attempts and actual retrieval; calibrated routing/abstention; zero invented critical facts on the holdout; tested role-specific fallback behavior; sealed randomized blind comparisons; original human ratings and reviewer attestations; win/tie/loss and uncertainty by workload; critical-defect escape rate; judge disagreement/order bias; cost and operator minutes per accepted editable design; end-to-end latency including failures/retries. Cluster repeated variants by original brief. Calibrate judges against humans; another vote from the same model is not independent validation. No AI-filled human ratings. A model upgrade qualifies only through safety and quality/cost evidence, not recency or predecessor agreement alone.

## W08 — Earn production qualification through a real pilot

**Priority:** final admission. **Owner:** operations lead and owner; independent acceptance reviewer. **Maps to:** R14 and all normative A–H gates. Depends on W01–W07.

Use the exact qualified deployment in a bounded, approved pilot across three clients and at least 100 real production tasks. Count only verified terminal deliveries; retain cancellations/failures in defined denominators. Record human approvals, revision/QC lineage, remote readback, editability, defects, rescue effort and all costs. Establish SLO/error-budget and rollback rules before expanding use.

Run actual mobile/desktop operator journeys for intake, review, correction, approval, retry and delivery without a terminal. Record task completion, errors and assistance. Verify keyboard navigation, focus, screen-reader labeling and contrast through real browser/manual checks against applicable NFR-021/Gate F requirements; source-substring tests do not prove usability or accessibility.

**Required proof:** ≥95% complete without technical rescue and zero observed critical isolation/factual/editability escapes as specified in the pilot contract; actual owner/human acceptance; complete task-to-artifact evidence; independent replay of release refusals and recovery. Zero observed incidents in 100 tasks is not proof of zero future risk. Gradually widen only within demonstrated workload and capacity. Human signoff, not an agent-generated QUALIFIED string, closes this task.

## Final proof request to the implementing agent

Return a table of every task with PASS/FAIL/NOT_RUN/BLOCKED, requirement IDs, exact commit/image, command, raw output, artifact hashes and reviewer. Include the full list of outstanding failures and changes to earlier claims. Demonstrate each previously failing probe now rejects or recovers correctly, and demonstrate that deliberately breaking the fix makes the test fail again. Separate simulated, real isolated service, live external, production and human evidence. Do not say “10/10,” “fully complete,” “zero risk,” or “world's best” without the corresponding bounded comparative evidence—and never use those phrases to conceal an unrun gate.
