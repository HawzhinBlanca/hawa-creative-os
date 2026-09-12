# Hawa — deep independent audit

**10 September 2026 · Current running app + frozen working-source inspection + adversarial tests against a separate PostgreSQL database**

## Verdict

**The system has improved, but its approval, quality, delivery, and recovery guarantees still cannot be trusted.** The strongest new evidence is that the repaired system can manufacture a passing QA record, approve an outdated revision, accept an invented session token, and certify incorrect delivery metadata. A deliberately nonsensical model still earns a perfect evaluation score.

This is not a recommendation to replace the interface you prefer or add more features. It is a list of the specific places where the existing system fails its own promises. Visual polish matters, but no visual score can compensate for approving the wrong artifact or losing the path to a saved revision.

**21 prioritized findings:** 3 P0 release blockers, 14 P1 correctness/reliability gaps, and 4 P2 experience defects. These are grouped root causes, not an inflated count of every failed assertion. P0 means block production qualification; P1 means fix before relying on the affected workflow; P2 means material usability or presentation work.

## What was actually checked

- Captured and inspected **12 fresh screenshots** of the running app at `http://localhost:8080`: inbox, intake, review, Figma evidence, DNA, library, client filtering, operations, evaluation, adapters, and mobile review. Default viewport was 572×674; responsive checks used 1440×1000 and 390×844. The first desktop capture was rejected while the viewport was reflowing and replaced with a verified capture.
- Inspected current source and compiled an isolated copy at `/tmp/hawa-deep-audit-20260910`. The repository contained extensive pre-existing modifications. Source fingerprints, deployment fingerprint, and source-change comparisons are saved alongside this report.
- Created **`hawa_audit_20260910`**, a separate database using the running database's schema-only dump. Office task data was not copied. The repository seed failed; only the audit setup corrected the two tenant-ID typos in memory to continue probing. The original failure is retained.
- Ran adversarial API and repository checks against that isolated database. All Google network calls in those probes were intercepted and given deliberately bad responses. That proves validation behavior; it does not constitute a real Google publication test.
- Used a **fresh Node subprocess**, rather than another `createApp()` call, for recovery verification.
- Ran the main test selection excluding the three tests wired to the live database, then ran those three against the isolated database in the frozen copy. No live approvals, Google uploads, chat messages, webhook changes, or production restarts were performed.

The app's code continued changing early in this run. The final comparison showed no difference between the tested snapshot and the checked current versions of Core, App, Review, publisher, approval repository, evaluation runner, and QA engine. The deployed Desk is older than parts of the working source; differences are called out below. This remains a dated audit, not a guarantee about later changes.

## Improvements that are real

1. Anonymous task creation is rejected with **401**. Cross-task approval is rejected with **400**. Those specific controls now work, although related authorization bypasses remain.
2. PostgreSQL is populated and reachable. The `hawa_app` role is **neither superuser nor BYPASSRLS**. Task records survive a fresh process, and authenticated task listing reads the database.
3. TaskService and TaskWorkflow are registered with Restate. Registration is real; durable activity execution is a separate unresolved issue.
4. The intake dialog now has dialog semantics and initial focus. Fit View now changes zoom and the mobile document stays within 390 pixels. Focus trapping and review usability still fail.
5. There is genuine Google upload/readback code. Its verification, reconciliation, and idempotency are not yet sufficient for production.

## Release blockers

### D01 · P0 — A newly invented token grants operator authority

**Proof:** the production-mode isolated app accepted a randomly generated, never-issued session-shaped bearer and created a task with **201**. The request then used server-assigned operator identity to create and approve revisions. Anonymous creation correctly returned 401, so this is a bypass of the new control, not a failure to enable production mode.

`verifyRequestAuth()` accepts tokens matching a string pattern, without consulting an issued session or checking a signature, expiry, revocation, or office membership. It also contains static fallback credentials; the Desk embeds a shared bearer. No credential values are reproduced here.

**Impact:** knowing the request format is enough to impersonate the operator. “Verified server-side” is not proof of a real human identity.

**Close with:** centrally enforced authentication; signed or opaque issued sessions; revocation and expiry; server-resolved office/client roles; no pattern-based or static production bypass. Test a new plausible-looking token, expired/revoked sessions, wrong roles, and legitimate users.

Evidence: `probes.json → forgedSession`, `anonymousIntake`; [Core authentication](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:1903). Requirements: FR-043, NFR-006, NFR-015.

### D02 · P0 — Approval creates its own passing QA evidence

**Proof:** a revision containing **“WRONG PRICE 9000 USD”** and no logo was approved with **201**. Before approval there were **zero QA runs**. After approval the database contained a QA row with `critical_pass=true`, `status=passed`, and an **empty report**. The approval returned `verified_qc_pass` as its QA reference.

The approval repository inserts a passing QA run whenever none exists. The API only blocks an explicitly false, in-memory QA report; an absent result is allowed. A plain task description also satisfies the “brief” check. A `nodes` object that was not an array was accepted as a revision and approved.

**Impact:** approval can turn untested content into apparently certified content. The checks are satisfied by creating the records that claim they passed.

**Close with:** approval must reference a pre-existing, immutable, successful QA run for the exact artifact hash and policy version. Missing, stale, malformed, errored, or failed QA must block approval. Validate the design schema before storage. An approval endpoint must never create QA evidence.

Evidence: `probes.json → qaBypass, nonArrayNodes`; [approval gate](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:3139), [manufactured QA row](/Users/hawzhin/Hawdesign/packages/db/src/repositories/revision.repository.ts:228). Requirements: FR-038, FR-043, FR-044.

### D03 · P0 — Publication still certifies fabricated or incorrect artifacts

**Proof:** a nonexistent relative file path caused the publisher to manufacture text bytes, submit them as a PNG, and report verified completion. A deliberately incorrect Drive readback — wrong ID, filename, MIME type, and size — was accepted. A physical 20-byte non-image was likewise “verified” against a reported size of **999,999 bytes**. An empty file list was accepted as complete.

The code reads physical files only for paths beginning with `/`, `./`, or `../`. Ordinary keys such as `deliverables/task.png` become a text buffer. It never establishes that the expected SHA-256 matches the uploaded bytes or the remote result. Its receipt assigns `verified: true` without those comparisons. Core currently supplies this exact relative-path pattern and placeholder hashes.

**Impact:** the green receipt can refer to text masquerading as an image, or to the wrong remote object.

**Close with:** resolve every artifact through one staging store; verify real bytes, type, length, and digest before upload; compare remote identity, checksum, size, destination and permissions; verify the actual approved package; reject empty packages. Preserve malformed-byte and incorrect-readback negative controls.

Evidence: `probes.json → publication, physicalMismatch, emptyPublication`; [publisher](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:145), [Core publication package](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2610). Requirements: FR-045, FR-048.

## High-priority reliability and quality gaps

### D04 · P1 — An old approval can authorize a newer revision

Created revision A, created revision B, then approved A. Response: **201**. Database: current revision **B**, task state **approved**. Repeated approvals also created additional decisions. There is no exact-current-revision/version precondition governing the approval transaction.

**Close with:** atomically lock or compare the task version, current revision, source hash and QA hash. Old approvals must return a conflict. Publication must use that exact approved revision, not whichever revision is current afterward.

Evidence: `probes.json → staleApproval, duplicateApproval`; [approval repository](/Users/hawzhin/Hawdesign/packages/db/src/repositories/revision.repository.ts:189). Requirements: FR-044, NFR-015.

### D05 · P1 — Sheets failure and database failure still produce completion

A controlled Sheets 503 left `sheet.synced=false` while the publication was **complete and verified**. Reconciliation then flipped `sheet.synced` to true with **zero network calls**. Another readback with the correct task ID but incorrect client, destination, state and hash was accepted.

Separately, an injected receipt-database failure produced **HTTP 202 with a complete receipt**, while the durable task remained **approved**. Core catches the storage error and continues broadcasting completion.

**Close with:** retain explicit pending/reconciliation states; verify the complete Sheet row; reconcile remote facts; persist receipt and task transition atomically. Do not advertise completion until all required guarantees are established.

Evidence: `probes.json → reconciliation, physicalMismatch, publicationDatabaseFailure`; [publisher reconciliation](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:365), [Core receipt error handling](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2691). Requirements: FR-048, FR-049, FR-050, NFR-015.

### D06 · P1 — Retrying publication can duplicate external work

A fresh publisher instance uploaded the same publication again. Reusing a key with changed content and a different client on the original instance simply returned the old success. The idempotency ledger lives in a Map, and Sheets uses append. There is no durable remote search/reconciliation before retry.

The outbox also leased a command whose availability time was tomorrow. Its lease method selects and updates separately without a guarded atomic claim. **The race is a source-level risk:** this run's two concurrent callers returned 1 and 0 commands, so duplicate leasing was not reproduced.

**Close with:** durable request-hash-bound publication keys, resumable stages, remote lookup after unknown outcomes, stable Sheet row identity, and atomic due-command leasing. Test process death immediately after remote success and before local acknowledgement.

Evidence: `probes.json → idempotencyChangedPayload, publisherRestart, futureOutbox, concurrentOutbox`; [outbox leasing](/Users/hawzhin/Hawdesign/packages/db/src/repositories/outbox.repository.ts:71). Requirements: FR-004, FR-047, FR-050, FR-060.

### D07 · P1 — Registered workflows do not yet form a durable production pipeline

The live database held **240 outbox commands, all pending**, at observation time. Source constructs an outbox repository but does not consume it. The Restate handlers ignore the supplied execution context and call a runner whose individual operations are not journaled. That runner does not persist the produced brief, revision or QA into the operational database and returns at awaiting approval rather than awaiting/resuming a durable approval signal.

**Close with:** one durable path from committed intake through dispatch, journaled operations, persisted output, approval wake-up and publication. Prove a real task leaves the outbox and survives interruption at each side-effect boundary. Registration and `/ready` alone do not qualify this.

Evidence: `live-restate.json`, `live-db-role-outbox.txt`; [worker handlers](/Users/hawzhin/Hawdesign/apps/worker/src/index.ts:6), [runner](/Users/hawzhin/Hawdesign/apps/worker/src/workflow.ts:40). Requirements: FR-060, NFR-011.

### D08 · P1 — Durable records and API-visible state disagree

Fresh-process task GET and listing succeeded, but the saved revision GET returned **404** because that route reads only the revision Map. Creating a task with explicit Kurdish headline/body returned them, but the next database-backed GET returned both as **null** and replaced the English headline with the task title. This is lost API fidelity; some original input remains in event payloads, so it is not a claim that every original byte is unrecoverable.

Routing returned 202 and changed in-memory client/state while SQL retained the original client and `received` state. Task reads can therefore describe a different state from the workflow being operated on.

**Close with:** hydrate complete aggregates from PostgreSQL; persist all transitions and language-specific copy; eliminate divergent Map-only routes and silent storage fallbacks. Recovery acceptance must reopen and use the revision, not merely find the task row.

Evidence: `probes.json → freshProcess, copyReadback, anonymousRoute`; [task normalization](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2126), [revision GET](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:3489). Requirements: FR-015, FR-060, FR-077.

### D09 · P1 — Sensitive routes still lack authorization

Without credentials, isolated requests changed a task's client route (**202**), wrote valid Client DNA (**201**) and changed a budget (**200**). A revision GET using another task's path returned the first task's revision (**200**). Live anonymous task listing also returned office task metadata. Approval's cross-task control is fixed, but the read and mutation surfaces are not consistently protected.

**Close with:** route-wide authenticated context and capability checks, plus task/client ownership predicates inside repositories. Validate access on reads as well as writes. Do not treat possession of an object ID or a private-network connection as a user identity.

Evidence: `probes.json → anonymousRead, anonymousRoute, anonymousDnaMutation, anonymousBudgetMutation, crossTaskRevisionRead`; `live-readonly.json`; [DNA write](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:3551). Requirements: FR-011, FR-017, FR-054, NFR-006.

### D10 · P1 — Review shows a locally reconstructed design, not proven revision content

Step 3 opened a live awaiting-approval task. The screen showed unrelated **50% off** promotional copy, a Ramadan translation and the generic four-node composition. Source hydration reads a browser draft or substitutes these defaults; it does not load the revision's actual node tree for this path. Unknown client mappings can leave the previous brand selected.

The review action sends **no Authorization header**, so the newly protected approval route rejects it. It also uses `rev-current` when the task lacks a revision ID. When there is no task, the standalone path manufactures a published receipt after a timer. The visible “Protected Tokens: Altered” warning does not disable approval.

**Close with:** render the exact persisted revision and hash, separate unsaved edits visibly, require saving and QA before approval, pass the authenticated session, and remove standalone fabricated publication. Missing copy should prompt for information, never produce an offer.

Evidence: steps 3–4, `03-review-dom.txt`; [hydration](/Users/hawzhin/Hawdesign/apps/desk/src/screens/ReviewScreen.tsx:634), [approval handler](/Users/hawzhin/Hawdesign/apps/desk/src/screens/ReviewScreen.tsx:4712). Requirements: FR-015, FR-041, FR-044, NFR-016.

### D11 · P1 — Autosave and offline recovery can silently drop work

Active drafts store only title and one copy field. They omit the Kurdish field and client selection. A storage-quota exception is swallowed; enqueue returns a success-shaped object although nothing was stored. With controlled API responses — intake 201 followed by route/brief/generate 400 — flushing returned **success=1, failed=0** and removed the queue entry.

The offline route payload lacks the required client ID. Its brief payload uses `exactCopy`, whereas Core's brief handler reads `copyBlocks`/`rawRequestText`. These are contract mismatches, not just transient failures.

**Close with:** save the whole draft with a verified storage result; display saving/failed/saved truthfully; retain the queued operation until the server accepts the full workflow command. Prefer one durable intake command over browser-managed orchestration.

Evidence: `draft-probes.json`; [draft storage](/Users/hawzhin/Hawdesign/apps/desk/src/services/draftStore.ts:18), [flush](/Users/hawzhin/Hawdesign/apps/desk/src/services/draftStore.ts:123), [brief endpoint](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2296). Requirements: FR-006, FR-015, FR-060, NFR-016.

### D12 · P1 — Deterministic QA does not establish visible, complete correctness

QA passed a manifest containing invisible text, an invisible logo, off-canvas content, a nonexistent font name and only one of two required output sizes. It also passed a required-logo brief when DNA contained no asset list. The engine checks whether supplied pages match *some* variant; it does not ensure every required variant exists. Text/hash presence is treated as sufficient regardless of visibility. Bounds warnings do not block the result.

The revision-QA endpoint additionally builds a fixed manifest instead of extracting the submitted design's actual manifest, and its result is not the durable approval binding.

**Close with:** schema-validated extraction from the actual artifact; complete per-variant coverage; visible copy and assets; actual font-file/glyph inspection; clipped/hidden content rules; and persisted evidence tied to the revision. Test bad content that is technically present but visually absent.

Evidence: `probes.json → hiddenCopyLogoAndMissingVariant, requiredLogoNoDna`; [QA engine](/Users/hawzhin/Hawdesign/packages/qa/src/engine.ts:21), [revision QA endpoint](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:3014). Requirements: FR-034, FR-037, FR-038.

### D13 · P1 — Figma canonical create/export/render still simulates an editor

With no bridge connected and **zero network calls**, create and export succeeded. Export claimed a 2,048-byte source file that did not exist. Rendering a 1080×1350 page returned a nonexistent 8,192-byte artifact described as 1080×1080. Exporting an unknown file/node as PDF returned success and **eight PNG signature bytes**, not a PDF.

Optional real Figma REST reads elsewhere do not prove that these canonical methods create or persist editable designs. The UI's claim that every design exists in Figma is therefore unsupported by this path.

**Close with:** real bridge execution, artifact serialization, format decoding, actual save/reopen/render, and semantic comparison after reopen. Fail explicitly when a capability is unavailable. Keep test doubles in test-only composition.

Evidence: `probes.json → figmaArtifacts`, step 4; [canonical source export](/Users/hawzhin/Hawdesign/packages/integrations/src/figma-bridge-adapter.ts:530), [node export](/Users/hawzhin/Hawdesign/packages/integrations/src/figma-bridge-adapter.ts:365). Requirements: FR-038, FR-045, FR-060.

### D14 · P1 — The evaluator recognizes the old attack instead of grading correctness

The old deliberately bad answer, `COMPLETELY_WRONG`, now scores **0/200**. Change that answer to `BANANA` with a positive confidence and it scores **200/200**, with zero critical violations. The loop has a literal rejection of the previous attack string; it still does not compare the answer with the case's ground truth.

The evaluation screen independently shows **134/134 passed** and admitted models while displaying **Cases (0)**. Retrieval evaluation also constructs evidence from expected answer IDs; it is not an independent held-out corpus qualification.

**Close with:** schema validation plus case-specific ground truth, abstention, protected facts and forbidden outcomes. Use unseen negative controls, an independently assembled holdout corpus, and real recorded provider outputs. Admission status must link to actual run results, not fixed UI text.

Evidence: `probes.json → wrongEval, namedEvalControl`, step 9; [evaluation scoring](/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:69). Requirements: FR-057, NFR-009.

### D15 · P1 — Operations still manufactures reassurance

Fresh screenshots show hardcoded backup age **14m**, seeded synthetic probes and **18 active durable invocations**. Figma says connected in one screen and sandbox emulated in another; WAHA says active in Operations and quarantined elsewhere. Integration “healthy” is based on configuration presence rather than demonstrated operation. The UI's 100% reconciliation claim is not supported by independently verified remote data in this audit.

**Close with:** timestamped observations from the actual subsystem; explicit unknown/unconfigured/stale states; separate synthetic tests from live measurements; immutable backup/restore and reconciliation receipts. Zero observed incidents is not evidence of successful monitoring.

Evidence: steps 1, 4, 8–10; [backup and invocation literals](/Users/hawzhin/Hawdesign/apps/desk/src/screens/OpsScreen.tsx:355), [seeded SLO probes](/Users/hawzhin/Hawdesign/packages/testkit/src/slo-daemon.ts:114). Requirements: NFR-011, NFR-015, FR-070.

### D16 · P1 — Clean setup fails, and the milestone test overstates its proof

The unmodified seed failed against an empty copy of the live schema: two client-membership rows reference the wrong tenant. Its transaction rolled back. Existing populated databases can hide this defect.

The milestone test passed, but its “crash” checkpoints are additional `createApp()` calls in the same process. Its publisher explicitly emulates the network, and its “PNG” is text bytes. Those are useful integration-test components; they are not physical production delivery or process-crash proof. The backup test parses SQL strings into arrays rather than restoring task data.

**Close with:** execute schema/seed from zero, run genuine child-process/container interruptions, decode resulting files, and restore populated database plus source assets and workflow state into a clean isolated target. Give each test the scope it actually establishes.

Evidence: `seed-failure.txt`, `durable-tests.log`; [seed membership rows](/Users/hawzhin/Hawdesign/db/seed.sql:54), [milestone recovery and emulation](/Users/hawzhin/Hawdesign/apps/core/test/milestone1-vertical-slice.test.ts:98), [backup test](/Users/hawzhin/Hawdesign/packages/db/test/backup-restore.test.ts:49). Requirements: FR-060, FR-070.

### D17 · P1 — Reject is recorded as a request for revision

An explicit `decision=rejected` returned `decision=revision_requested`, and the task entered revision_requested. The database approval row uses rejected while subsequent application behavior handles revision. Escalation has a similar mapping risk in source.

**Close with:** retain the selected outcome consistently across API response, immutable decision, task state, timeline and notification. Reject, revise and escalate must have distinct tested meanings.

Evidence: `probes.json → rejection`; [decision response mapping](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:3201), [task-state mapping](/Users/hawzhin/Hawdesign/packages/db/src/repositories/revision.repository.ts:317). Requirements: FR-043, FR-052, NFR-015.

## Experience and quality imperfections

### D18 · P2 — Review overload hides the work and the next decision

At 390×844 the first screen is almost entirely navigation and toolbars; there are **95 buttons in the document**. Desktop mixes format selection, WhatsApp, commercial presets, Figma, exports, history, and editing controls around the same review. Labels such as “Ingress”, “AST”, “Bidi Isolates”, hashes and architectural invariants make the operator interpret implementation details.

Fit View now scales the design, but this sample shrinks to roughly a third of its original size inside a tall canvas, making text difficult to inspect. The tiny logo, dominant ellipse, unrelated offer and broad empty regions in the sampled review are not a client-ready composition.

**Improve within the existing UI:** give review one large artifact and three clear actions; show tools when the user selects an element or enters editing; place integrations and exports behind focused controls; use a mobile review layout with readable preview, compact status and accessible decisions. Preserve the workflow and visual elements you like.

Evidence: steps 3, 11–12, `mobile-metrics.json`. Requirements: FR-041, NFR-016.

### D19 · P2 — Client identity and library filtering contradict themselves

Selecting **FastPay** under “Client Isolation” still displays an **Aster** podcast template and “Same client (Aster)” retrieval explanation. Fixed library totals remain unchanged. This demonstrates a UI/filter defect, not proof that a backend tenant boundary leaked private records.

The deployed intake expands KAAE incorrectly and lists legacy string client IDs; source has since narrowed intake to KAAE and corrected that label. DNA still describes Aster as a hotel while Studio describes a pharmacy. Passing a legacy `client-drustee` ID into durable intake returned **503**, classified as storage failure, rather than a useful validation error.

**Close with:** one canonical client registry and schema across UI, DB, DNA and templates; derive filtered cards and counts from the same scoped result; display real retrieval reasons only; map stale client choices or reject them clearly. Verify the deployed build after fixing source.

Evidence: steps 2, 5–7, `probes.json → clientIdentifier`. Requirements: FR-011, FR-017, FR-021, FR-023.

### D20 · P2 — Accessibility fixes are partial

The modal has a dialog role and title autofocus, but Shift+Tab from the first select goes to the background **Inspect bidi** control. The page behind it is still keyboard-active. Dense, small controls and clipped navigation make mobile operation harder; unlabeled arrow controls have ambiguous accessible names. The DNA palette labels a background color “Fail 1:1” against itself, confusing a palette relationship with a text-contrast failure.

**Close with:** trap and restore modal focus, make the background inert, label icon-only controls, test target spacing and keyboard order, and evaluate real text/background pairs. Test the critical workflow with a screen reader and native Sorani reviewer. Screenshots and DOM inspection do not establish full WCAG conformance.

Evidence: `modal-focus.json`, `mobile-metrics.json`, steps 2, 5, 11–12. Requirements: FR-034, NFR-009, NFR-016.

### D21 · P2 — Creative planning evidence remains weaker than its claims

The inspected creative planner selects one fixed topology and stock rationale, then supplies an art-direction image path and symbolic hash without creating that image. The worker retrieves a context pack but does not consume it. The inspected retrieval service uses an in-memory corpus and substring scores while assigning constant “vector” and rerank values. These may be scaffolds, but they cannot establish superior creative judgment or learning.

The fresh library thumbnails are mostly sparse text blocks, backgrounds and decorative shapes. They are recognizable templates, but there is no fresh blind human evidence that their results beat the user's current workflow. New KAAE template work was occurring during the audit; those later outputs are not judged here.

**Close with:** make evidence paths real; apply retrieved approved rules/assets to generation; measure actual output against representative real briefs and professional references. Use human preference and correction effort alongside objective correctness. Do not claim the highest-quality output from canned plans or an unqualified evaluator.

Evidence: steps 3 and 6; [planner](/Users/hawzhin/Hawdesign/packages/creative/src/creative-director.ts:22), [unused worker retrieval](/Users/hawzhin/Hawdesign/apps/worker/src/workflow.ts:66), [retrieval scores](/Users/hawzhin/Hawdesign/packages/retrieval/src/retrieval-service.ts:42). Requirements: FR-020, FR-023, FR-039, FR-057.

## Fresh validation results

| Check | Result | What it establishes |
|---|---|---|
| Main test selection, three live-DB tests excluded | **418 passed, 1 failed; 65 files** | Remaining failure: ResilientModelGateway tournament timed out at 25 seconds. |
| Three DB test files, isolated DB, frozen copy | **9 passed; 3 files** | These integration tests pass in isolation; their mock/restart limitations remain. |
| Working-source and frozen-copy TypeScript build | **Pass** | Compilation only. Generated build outputs/caches refreshed; no application source was edited by this audit. |
| Blueprint/package validator | **449 pass, 3 fail** | `.env` flagged by the secret/package check; checksum coverage and `.env` checksum also fail. No secret values reproduced. |
| Adversarial database/API/publisher/QA probes | **Multiple reproduced violations** | Detailed structured results in `probes.json`; legitimate controls are listed separately. |
| Draft/offline negative controls | **Silent failure reproduced** | `draft-probes.json`; in-memory browser storage substitute and controlled fetch responses. |
| Fresh process recovery | **Partial** | Task survives; revision API fails; language-specific copy is absent from readback. |
| Real Google/Figma delivery and complete host restore | **Not performed / not qualified** | No claim of genuine provider delivery or clean-host recovery from this run. |

The two test selections total **427 passing tests and one failing test**, but they were separate runs with different database setup. They must not be presented as one clean, unmodified `pnpm test` run. The temporary copy's first pnpm invocation hit a workspace-link setup issue; direct use of the existing TypeScript executable compiled it successfully afterward.

## Repair order and exact exit conditions

1. **Restore truthful authority and completion:** remove session-pattern/static bypasses, implicit QA passes, manufactured artifacts and UI receipts. Negative controls D01–D05 and D09 must fail safely before real client work is trusted.
2. **Unify durable state:** real aggregates, full copy and revision hydration, atomic current-revision approval, correct rejection semantics, complete intake contracts and honest offline storage. Demonstrate creation → edit → restart → reopen → review using the same artifact hash.
3. **Make execution durable:** consume the outbox, journal real operations, persist safe checkpoints and resume approval/publication. Kill the process before/after every boundary and verify no duplicate external effect.
4. **Verify physical design and delivery:** reopen editable source, render/decode every required format, verify visible copy/assets/fonts, upload to the configured destination, independently compare bytes/metadata and the full Sheet row. An unknown outcome must remain pending until reconciled.
5. **Qualify quality, then polish the workflow:** ground-truth evaluation that rejects unseen wrong answers, blind review of real office briefs, recorded correction effort, and focused desktop/mobile review. Replace every operational badge with observed evidence.
6. **Rebuild and recover from zero:** clean schema/seed, current dependency/build checks, actual populated backup and restore, then a limited real office pilot with recorded outcomes. No “10/10” declaration until these are demonstrable.

## Captured walkthrough

Each screenshot below was captured in this run, saved, reopened and inspected before acceptance. Strengths and limits are stated with the step. The browser steps were observational; actual dangerous transitions were tested only in isolation.

### 1. Inbox — misleading status and test-data clutter

Clear entry point and visible queue cards. Fixed counts and mixed test/office cards make workload unreliable; default-width navigation clips. No live task was created.

![Step 1: current inbox](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/01-inbox.png)

### 2. New task — improved semantics, incomplete focus and draft safety

Clear bilingual fields and initial focus. Focus escapes the dialog, autosave omits fields, and this deployed client selector differs from current source. Submission was not attempted in production.

![Step 2: intake dialog](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/02-intake.png)

### 3. Existing task review — wrong content and untrustworthy approval path

Editable controls and visible QA warning are useful. The canvas is reconstructed with generic copy, not proven to match the selected revision; the protected-copy warning coexists with enabled approval. No live approval was attempted.

![Step 3: desktop review](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/03-live-review-desktop.png)

### 4. Figma evidence — unsupported live-workspace claims

The panel explains where editing is supposed to happen. Its connected/live claims are contradicted by adapter behavior and runtime mode. No external Figma file was modified.

![Step 4: Figma panel](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/04-figma-claims.png)

### 5. Client DNA — useful structure, unreliable proof labels

Palettes, assets and versions are grouped clearly. Symbolic “verified” hashes, fixed learned-rule claims and contrast labels require correction. No production DNA was edited.

![Step 5: brand governance](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/05-client-dna.png)

### 6. Library — recognizable previews, weak provenance

Visual cards are more useful than filenames alone. Fixed inventory counts and sparse generic output do not establish professional quality. No template was inserted into a live task.

![Step 6: creative library](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/06-library.png)

### 7. Client filtering — confirmed mismatch

FastPay is selected, yet Aster material and its retrieval explanation remain. This is an observed UI isolation defect; backend tenant exposure was not inferred from the screenshot.

![Step 7: FastPay filter with Aster result](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/07-library-filter.png)

### 8. Operations — reassuring claims exceed evidence

The screen exposes useful categories, but backup, invocation, synthetic-probe and reconciliation claims need actual receipts. No operational action was triggered.

![Step 8: operations](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/08-operations.png)

### 9. Evaluations — qualification cannot be trusted

Dataset selection and case search are understandable. Perfect totals and model admission conflict with an empty case list and the adversarial scoring failure. No paid tournament was launched from the UI.

![Step 9: evaluation status](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/09-evaluation.png)

### 10. Adapters — connected and simulated mixed together

Capability separation is useful, but “Bridge Connected” and “sandbox_emulated” are presented simultaneously. No credentials panel, webhook mutation or messaging action was used.

![Step 10: adapters](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/10-adapters.png)

### 11. Mobile review entry — overloaded

The document fits the viewport width, an improvement. The first screen is mainly controls; the art and decision remain far below. Target-size and screen-reader qualification remain incomplete.

![Step 11: mobile toolbar](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/11-mobile-review.png)

### 12. Mobile Fit View — functional but too small for careful review

Fit View changes zoom to 33% and exposes the canvas. The resulting design text is tiny inside a large work area. Full readable review and convenient decision controls still need a mobile-specific arrangement.

![Step 12: mobile fit](/Users/hawzhin/Hawdesign/output/audits/2026-09-10-deep-audit/screenshots/12-mobile-fit.png)

## Limits and retained evidence

This is a deep bounded audit, not proof that every bug has been found. No production outage, real external upload, full clean-host restoration, native-speaker creative review, screen-reader certification, long-duration soak or public penetration test was conducted. The publisher tests deliberately substitute remote responses; the draft tests substitute storage. Their findings concern how real application code handles those inputs.

The evidence includes source/deployment hashes, DOM snapshots, keyboard/viewport measurements, read-only runtime results, the isolated database setup and seed failure, executable probes, test logs, and screenshot hashes. Later edits require rerunning relevant tests. Existing historical “fully remediated” claims are not used as audit evidence.

**Recommended next action: close D01–D05 as one tested approval-and-publication boundary, then prove revision recovery before expanding the product.**
