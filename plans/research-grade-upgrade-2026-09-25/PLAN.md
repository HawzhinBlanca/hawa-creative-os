# Hawdesign research-grade upgrade programme

**Status:** implementation plan; no feature or production change is admitted by this document.

**Branch:** `codex/research-grade-design-system` from `studio-v2` commit `1c1316d`.

**Evidence baseline:** [25 September reality check](../../output/audits/2026-09-25-architecture-design-reality/REPORT.md), [24 September architecture programme](../../output/plans/2026-09-24-architecture-programme/PLAN.md), [designer-grade revisions](../../output/plans/2026-09-23-designer-grade-revisions/PLAN.md).

**Execution register:** [WORK_ITEMS.csv](WORK_ITEMS.csv). **Study protocol:** [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md).

## 1. Outcome and claim discipline

The target is a demonstrably better private-office design system: reliable intake through approved delivery, client-general and culturally sound design, editable and verified Canva artifacts, controlled model use, and measured creative quality. We will report **three independent admissions**:

1. **Engineering release:** exact commit, migrations, deployment image, flags, test and chaos outcomes, restore drill, and unresolved failures.
2. **Operational workflow:** live counts and traces from intake to requester receipt, including manual intervention, uncertainty, latency, and cost. Draft handoff and approved delivery are named separately.
3. **Creative quality:** blinded human preference and defect measurements on current final exports, with confidence intervals by client, language and format.

There is no aggregate 10/10 until all three have passed their own gates. A zero observed defect count is reported with sample size and a confidence bound, never as proof that defects are impossible. A green test suite is not evidence of taste; a model's rating is not a human label.

## 2. Decisions already selected

- **Canva remains the sole active editor/export studio** under ADR-020 and ADR-025. The old HyCanvas instructions in `AI_BUILD_PROMPT.md`, `DECISION_SUMMARY.md`, parts of `MASTER_SPEC.md`, and `docs/06_EDITABLE_DOCUMENT_STRATEGY.md` are historical conflicts to reconcile in R00. This plan does not switch studios or revive an alternative.
- PostgreSQL is operational truth, Hawa Desk is the canonical office interface, and one Restate-owned durable lifecycle controls side effects. Telegram is an adapter. Client scope is fixed before retrieval. Human approval binds a pinned revision and cannot be self-issued.
- Hard copy, asset, permission, editability, multilingual and publication checks outrank an aesthetic model. Ambiguous provider or external-send outcomes remain **unknown** until reconciled.
- Preserve the 24 September programme's blue/green deploy, test database isolation, file store, status contract, renderer safeguards, and its measured **NO-GO** on resvg. Finish its Phase 2.3–2.6 instead of building another workflow framework.
- Model roles are selected by measured quality, cost, latency and failure behavior, not by a universal “latest” label. The present Astra and Sunburst choices are challengers, not automatic winners.

Any change to these foundations needs an ADR first. Every implementation slice identifies its requirement IDs, reads its `plans/traceability.csv` source document, ships vertical behavior with negative tests, and updates traceability only after evidence exists.

## 3. Baseline and execution order

The observed build at `1c1316d` had a red release gate: stages 1–6 passed; stage 7 had 9 failed tests in 4 files. A targeted rerun reproduced them. The live 48-hour snapshot showed 7 briefs, 4 drafts, 0 approvals and 0 deliveries; the current funnel explicitly treats a Canva draft link as the product boundary. Global v3 flags and the new lifecycle were off, while v3 pilot chats were configured. These observations do not establish the cause of every failure or the quality of today's unseen designs.

| Gate | Work | Exit evidence | Dependency |
|---|---|---|---|
| **G0: trustworthy baseline** | R00–R03: reconcile requirements and docs; classify/fix all nine failures; freeze manifests, scenarios and current metrics; make health distinguish configured from verified. | A clean release-gate run on this branch; red-before/green-after proof for every changed behavior; no skipped critical test; build/flag stamped baseline. | First. No quality or reliability promotion while red. |
| **G1: study infrastructure** | R04–R06: curated multi-client corpus, sealed splits, human study and judge calibration harness. | Versioned dataset manifest with rights/provenance; pre-registration and immutable holdout seal; rater UI records blind, randomized choices and cannot reveal arm. | G0; may run alongside later software slices once frozen. |
| **G2: closed lifecycle** | R07–R10: complete existing RequestLifecycle 2.3–2.6, office decisions, delivery reconciliation, canary and recovery. | Real Desk/Telegram request → draft → revision → approval → pinned export → Drive/Sheets → requester receipt; kill/restart and uncertain-send drills with one logical effect. | G0; reuses worker poller/Delivery 2.1–2.2 already built behind flags. |
| **G3: client-general creative inputs** | R11–R15: versioned BrandKit/DesignIntent, approved examples, client-filtered multilingual/visual retrieval, concept diversity, factual-copy locks. | Same evaluator runs on at least three unlike clients, English/Sorani/Arabic/mixed, multiple formats; zero seeded cross-client or brand-asset escapes; improved held-out retrieval and diversity without preference regression. | G1 corpus and G0 contract; can build alongside G2. |
| **G4: actual-artifact quality** | R16–R19: final Canva export hard gate, revision/hash binding, truthful review evidence, editability and restore drills. | Deliberately corrupted final exports are refused; after a Canva edit the captured artifact/version changes and approval is invalidated; supported elements reopen; unsupported portability is stated. | G2 revision binding; G3 brand constraints. |
| **G5: provider and cost boundary** | R20–R23: one typed egress/budget policy, durable model outcome ledger, long-call transport experiment, role tournament. | Local-only negative test; crash-after-acceptance/reconcile drill; complete cost/latency/error receipts; candidate promotion only after offline, shadow, canary and rollback checks. | G0 and G1; integrate before broad G3/G4 canary. |
| **G6: independent admission** | R24–R27: blind human test, judge calibration, live pilot, operations and final claim decision. | Pre-registered analysis, confidence intervals by brief and strata, actual exported artifact receipts, clean-host restore, operator runbook, and explicit unresolved-risk list. | G0–G5. |

Use a separate migration or rollout flag for each vertical slice where behavior changes. Each canary has a defined rollback and data-reconciliation procedure; no flag is switched for all chats at once. Estimate effort after G0 inventory; availability of real briefs, designers and native-language reviewers governs G1/G6 calendar time.

## 4. Implementation contracts

### G0 — restore trustworthy truth

**R00 contract reconciliation.** ADR-025 wins on active studio. Record an ADR/addendum for any additional semantic change, then mark superseded passages in `AI_BUILD_PROMPT.md`, `DECISION_SUMMARY.md`, `MASTER_SPEC.md`, `docs/06_EDITABLE_DOCUMENT_STRATEGY.md`, `docs/11_QA_RTL_MULTILINGUAL.md`, `docs/29_ACCEPTANCE_GATES.md`, OpenAPI/schema and `plans/traceability.csv`. Do not delete the historical text without a pointer to its superseding decision. Remove `.hyc` from *current* NFR-010 evidence and define the Canva design ID, pinned local export/source package, supported editable elements and recovery limitation precisely. A generated current-contract check should prevent drift.

**R01 gate failure triage.** Reproduce each of the nine failures on a fixed baseline. For each record: requirement, expected current behavior, production route, whether test expectation or code regressed, red test, minimal fix, and negative control. Passive Telegram text must obey FR-005; do not “fix” tests by creating unwanted tasks. Run targeted tests, then the full release gate in an isolated DB on the branch. Keep the previous red transcript.

**R02 operational semantics.** Health exposes `configured`, `reachable`, `paid_verified`, `stale` and `unknown` as distinct states. An unrun paid probe is never called connected. Cohort/task age and p50/p95 time per stage identify stuck tasks even when other drafts succeed. The operator sees a safe next action, not a reassuring aggregate.

**R03 provenance.** Stamp checkout SHA, image digest, migrations, flags, model/prompt versions and build time into every release/evaluation record. Artifacts and approvals always cite their input and final-export hashes. The release gate fails if the reported build and shipped image differ.

### G1 — evidence before optimization

**R04 corpus.** Start with the 200-task minimum already specified in `docs/07_MODEL_REGISTRY_AND_EVALUATION.md` when lawful/available; use faithfully reconstructed briefs only with a provenance label. Stratify by client, campaign, language, format, task class, reference use and revision difficulty. Split by **campaign/request lineage**, not individual image, so a derivative cannot leak into both development and holdout. Record inclusion/exclusion and rights; keep private client assets inside authorized office storage.

**R05 human study.** Build on the existing comparison-study UI and ask ledger in the designer-grade revisions plan; do not recreate them. Freeze study protocol and randomization before final outputs are seen. Judges receive same-size anonymized *Canva exports* and the same brief. A native Sorani reviewer checks all critical Sorani cases. Preserve individual votes, ties, uncertainty and reasons. Do not count multiple judges on one brief as independent briefs. Details in [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md).

**R06 machine-judge calibration.** Retain deterministic hard filtering. In the aesthetic arm, hide composite metric scores from the judge, permit ties/abstention, swap left/right order and compare by human labels. Test current mini judge, Astra, metrics-only and a different-family candidate only if authorized. Report defect sensitivity, false-block rate, agreement and cost by language/format; do not promote on agreement with Astra's earlier verdicts.

### G2 — one recoverable request lifecycle

**R07–R10** implement and verify the existing [Phase 2 design](../../output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md): questions, requester decisions and reminders (2.3); Desk office decisions with expected revision and action key (2.4); retirement of obsolete truth-holding routes/maps (2.5); dated cutover, Restate backup/restore and delayed-handler compatibility (2.6). The 2.1 poller and 2.2 Delivery path are present but flagged off; first qualify their combined behavior without silently activating them. No HTTP/database model owns a second state machine. A sent-but-unconfirmed Telegram message is **uncertain**, surfaced once to the office, and never blindly replayed. Drive/Sheets remain independently reconciled after approval. Keep old requests on their original executor until complete.

### G3 — client-general design intelligence

**R11 BrandKit/DesignIntent.** Define pure domain schemas for approved client colors, fonts, logo variants/clearances, image policy, locale, exclusions, audience, medium and campaign. Compile them from signed Client DNA versions, with provenance and hash. Move KAAE-specific instructions out of the general Canva planner and v3 prompt into a KAAE data profile. Missing brand facts pause or use an explicitly approved neutral mode; never borrow another client's colors or assets. Test incompatible clients in the same process.

**R12 retrieval.** Authoritative IDs/rules use structured lookup; lexical search is named lexical. Build versioned client-filtered text/visual example indexing only after exact authorization filtering at query time. Reuse PostgreSQL/pgvector if measured sufficient; benchmark lexical-only, hybrid and reranked variants on the sealed relevance labels. Preserve approval/deprecation, negative examples, original Sorani text and source hashes. Zero cross-client leakage is a hard condition, not an average. A new embedding or reranker is admitted only if recall/quality gain justifies its operational cost.

**R13 concepts.** Separate idea generation from layout coordinates. A concept specifies a focal idea, reading route, asset architecture, hierarchy and allowed archetype. Generate a bounded set of meaningfully distinct plans under immutable copy/brand constraints. Detect near duplicates from actual geometry and imagery, not prompt labels. Keep a strong template baseline and a human choice for uncertainty. More distinct shapes alone do not count as better designs.

**R14–R15 copy and learning.** Lock exact approved text and official assets through every candidate, revision and export. Extend the existing ask ledger and guarded edit operations rather than rebuilding them. Feedback becomes a proposed, scoped client rule only after authorized human acceptance; rejected designs are negative memory, not inspiration.

### G4 — Canva is measured at the final boundary

**R16 final-export preflight.** After each capture or edit, export the actual Canva PNG and source/semantic format available for that design. Run source text/font extraction, protected-token and asset checks, geometry/safe-zone analysis, blank/clip/overlap detection, and Sorani glyph inspection against a pinned export hash. Image OCR is supporting evidence; source text is authoritative where present. Critical failures block review/approval/publication. Missing/unavailable parity is `unknown` and routes to a person, never a pass. Calibrate thresholds on development defects, then freeze them for a seeded holdout.

**R17–R18 approval and truth.** Approval references task, exact revision, captured export hash, QC profile/hash and actor. An edit or recapture changes the hash and invalidates approval. Remove plausible fallback Canva IDs, capture paths/hashes, colors and fonts from dormant or active review endpoints; return explicit `not_captured`/`not_configured`. Verify read-back of the exact uploaded files and Sheet row before completion.

**R19 portability.** Execute manual-edit → save → export → reopen, plus account/cloud-loss reconstruction drills for text, logos, photos, vector shapes and Sorani. A Canva URL is the working editable master; Hawa's brief/recipe/assets and archived exports support reconstruction but may not preserve arbitrary human edits. Label each element as fully restored, partially restored or lost; claim vendor independence only within the measured boundary. Do not imply Canva SVG export is live-text source.

### G5 — model calls under one policy and durable evidence

**R20 egress.** Put planners, critique, image and evaluations behind one typed provider authorization boundary. Before dispatch, resolve client scope, data class, local-only rule, exact role/model/prompt/schema and budget. A repository architecture check rejects direct provider calls outside registered adapters. A seeded `local_only` task with text, photo and audio must make zero external requests.

**R21 uncertain outcome.** Persist a stable logical-call identity and attempt record before sending; store provider request/response ID when received. After timeout or crash, distinguish `not_sent`, `accepted_unknown`, `complete` and `failed`. Reconcile by provider ID where supported; otherwise stop and expose uncertainty rather than automatically paying twice. Never infer “not billed” from a fetch error. Apply client/run/day budget caps to evaluation scripts as well as production.

**R22–R23 transport and tournament.** Spike durable Responses background for long Astra calls *only if* data retention, schema/vision behavior, cancellation, cost and polling fit each client's policy; otherwise use a bounded alternative. Compare current low effort against medium on the fixed holdout and record quality, p95 latency, error, tokens and dollars. Resolve roles through the versioned registry; offline → shadow → small canary → rollback must precede promotion. Routine template work keeps its deterministic/cheap route where it meets quality.

### G6 — demonstrate the actual improvement

**R24** run the pre-registered blind comparison on current final exports; report both new-versus-current and, if office resources permit, new-versus-human designer. **R25** measure the complete production funnel and change rounds, with per-task numerator/denominator and no hidden manual rescue. **R26** repeat restart/uncertain-send, client isolation, provider policy, final-export sabotage, edit/reopen and clean-host restore drills on the exact candidate image. **R27** publish a release dossier with dated evidence for Gates A–H in `docs/29_ACCEPTANCE_GATES.md`, role- and client-specific limitations, operator procedures, rollback artifacts and traceability rows. The owner may accept a limited pilot without conferring a universal 10/10 claim.

## 5. Release and stopping rules

- **Immediate stop/rollback:** wrong client/permission, invented protected fact, changed approved copy, wrong/missing official asset, unapproved publication, missing editable working source, duplicate logical delivery, or silent data loss. Record the artifact and trace; preserve forensic state.
- **Aesthetic shortfall:** keep existing planner or route to a designer; do not lower hard QA or tune on the sealed holdout. A candidate can be cheaper without becoming primary if quality non-inferiority was not established.
- **Provider or Canva outage:** hold the request at a recoverable state, show operator action, keep paid/side-effect outcome `unknown` where appropriate, then reconcile. Never fabricate a receipt or rerun an uncertain send to make the dashboard green.
- **Promotion:** full release gate green; all hard invariants and chaos checks pass; human quality decision meets the frozen protocol; the canary shows no new critical escapes and can be rolled back. Report remaining limitations instead of forcing a score.

## 6. Implementation handoff

Start with **R00 and R01**. Record the present nine failures and expected behavior before editing tests. Then take one work-register row at a time: identify its requirement IDs and linked source document; capture a failing behavior/negative control; implement the smallest full vertical slice; run targeted tests and the relevant chaos or browser drill; run the full release gate at each promotion boundary; attach artifact hashes and traces; update that requirement's `plans/traceability.csv` evidence; mark the row accepted only when its exit evidence is independently reproducible. Keep skipped, failed and unexecuted checks explicit. Each promotion record states the flag/default and rollback procedure.

Human-dependent inputs for later gates are approved briefs/assets from at least three distinct clients, access to a native Sorani reviewer, independent design judges, and permission to show any private designs to those judges. Their absence delays the human-quality claim; it does not block engineering and offline evaluation work. Budget actual provider/Canva calls before launching experiments and preserve the per-run ledger even if a run stops early.

## 7. Normative map and references

The work register maps each slice to requirement IDs. Read the corresponding row of `plans/traceability.csv` and its source document before implementation. The core sources are `docs/07_MODEL_REGISTRY_AND_EVALUATION.md`, `docs/08_MEMORY_RAG_CLIENT_DNA.md`, `docs/09_MESSAGING_AND_OFFICE_INBOX.md`, `docs/10_WORKFLOW_RELIABILITY.md`, `docs/11_QA_RTL_MULTILINGUAL.md`, `docs/13_GOOGLE_DRIVE_SHEETS.md`, `docs/14_SECURITY_THREAT_MODEL.md`, `docs/18_FEEDBACK_LEARNING.md`, `MASTER_SPEC.md`, and ADR-020/025/032/037. Several still contain historical HyCanvas passages; R00 must resolve their current authority before code changes depend on them.

External research and API boundaries (checked 2026-09-25): [DesignSense human graphic-layout preferences](https://arxiv.org/abs/2602.23438), [DesignPref on designer disagreement](https://arxiv.org/abs/2511.20513), [Visual Aesthetic Benchmark on comparative judgment](https://arxiv.org/abs/2605.12684), [OpenAI background Responses](https://developers.openai.com/api/docs/guides/background), [Canva import](https://www.canva.dev/docs/apps/rest-apis/reference/design-imports/) and [export](https://www.canva.dev/docs/apps/rest-apis/reference/exports/) APIs. These motivate experiments and identify documented capabilities; they are not proof that Hawdesign passes them.
