# Hawdesign — professional reliability completion contract

Prepared 5 September 2026 · Project: `/Users/hawzhin/Hawdesign` · Status: **NOT production-admitted**

## 1. What this sheet means

The goal is a design application you can trust with Drustee's real work: editable Sorani designs, accurate exports, recoverable saves, predictable interaction, and honest status. The connected office system must additionally enforce identity, client isolation, durable workflows, genuine AI provenance, approval integrity and verified delivery.

“Apple grade” and “Adobe grade” are quality aspirations, not certifications or a claim that one project can reproduce those companies' entire feature sets. No finite test suite guarantees zero defects. This contract replaces a subjective 10/10 score with **explicit supported scope, reproducible evidence, independent review and release gates**.

This is a task sheet, not completed implementation. Every task starts OPEN. A passing unit suite is useful evidence, not permission to mark the product complete. Read [AUDIT.md](AUDIT.md) for the executed findings and qualifications. Preserve existing user/concurrent changes. Reproduce each defect against the nominated release commit before changing it.

### Keep the work lean

- Preserve useful UI, contracts, domain helpers and tests. Do not rewrite the product wholesale or introduce Kubernetes, an agent swarm, a plugin marketplace, social scheduling or billing.
- Use the existing PostgreSQL/Restate/adapter architecture unless a documented fitness test justifies an ADR. Do not assume the custom JSON `.hyc` package is a native HyCanvas file.
- Make **Hawdesign-first, Photoshop-optional** possible through fidelity and portability. Do not spend the first release implementing general Photoshop parity. Advanced retouching, difficult composites and unsupported interchange can remain an explicit optional external-editor route.
- Start Drustee with approved reusable templates, live Sorani text and independently replaceable imagery. No made-up prices, “verified” badges, contacts or health claims in a real template.
- Cap unsupported features behind honest disabled states. “Disabled by approved scope” is not “implemented” and cannot satisfy the full office specification.

## 2. Required proof for EVERY task

A task is DONE only when all of the following exist in its evidence directory. Missing evidence means OPEN or BLOCKED, never “assumed passed.”

1. **Identity:** task ID, exact requirement IDs, owner, verifier, UTC date, commit SHA, clean/dirty status, changed-file hashes, dependency lock hash, browser/runtime/OS/hardware and fixture versions. Dirty runs may diagnose; release admission must use a reproducible tagged candidate.
2. **Before and after:** reproduction demonstrating the old failure, followed by the same test on the fix and relevant positive controls. A newly written test that only agrees with a stub is insufficient. If a defect is no longer reproducible, document why and retain the regression test; do not claim an unverified fix.
3. **Executable verification:** actual command, working directory, sanitized configuration, exit code, raw logs, expected and observed result, case count and artifact paths. Distinguish unit, real integration, browser, external sandbox, fault injection and human review.
4. **Failure proof:** at least the task's stated negative tests. Required safety tests must fail when the safety guard is deliberately removed in a disposable checkout. Do not inject faults into real customer data.
5. **Output evidence:** source files, manifest/digests, reopened files, semantic/pixel diffs, screenshots/video, traces or provider read-back as relevant. A screenshot of a green badge cannot prove saving, authorization, backups or publication.
6. **No hidden bypass:** no skipped required tests, forced pass, fabricated metric, catch-and-success, disabled check, unreviewed golden update or production fake. Optional exclusions need a named scope decision and visibly disabled capability.
7. **Review:** a second reviewer checks the actual artifacts for security, data integrity and release-critical tasks. Native Sorani/Arabic review is human work; do not invent signatures. Remaining limitations, rollback and safe user action are written down.

Store a receipt per task under `evidence/releases/<release-id>/<task-id>/completion.json`. Suggested fields:

```json
{
  "taskId": "HD-001",
  "status": "OPEN",
  "releaseId": null,
  "commit": null,
  "requirements": [],
  "owner": null,
  "independentVerifier": null,
  "environment": {},
  "runs": [],
  "artifacts": [],
  "negativeControls": [],
  "humanReviews": [],
  "limitations": [],
  "rollback": null
}
```

For every artifact record relative path, media type, real byte size and SHA-256 of its actual bytes. For every run record command, timestamps, exit, expectations and observations. Keep credentials, tokens and sensitive customer content out of shareable receipts. A hash identifies bytes; it does not prove their correctness or make a record immutable.

## 3. Priority, sequence and release boundaries

**P0:** data loss, unauthorized access, wrong content/output, fabricated completion or missing fundamental execution. Blocks real work in the affected mode. **P1:** professional usability, operational safety and proven quality; required before general supported release. **Conditional:** required before enabling the named optional capability.

| Stage | Outcome | Tasks |
|---|---|---|
| A | Truthful, safe foundation | 001–009; establish 032 immediately |
| B | Reliable editable design tool | 010–019, with 033–036 and 039 in parallel |
| C | Genuine office workflow | 020–029 and 038 |
| D | Reproducible operations | 030–032 and 037–040 |
| E | Observed production readiness | 041–042 |

Dependencies below govern implementation, not arbitrary calendar promises. Related tasks can be developed concurrently once their contracts are agreed. Estimate engineering time only after Stage A establishes what is real; this is not a cosmetic weekend polish.

### Gate L — limited local Drustee design pilot

Requires HD-001, 004, 009–019, 032–036, 039 and the local portions of 031/038/042. Complete the focused Drustee rehearsal below. This is a **limited pilot**, not full office admission.

The build must either have authenticated, isolated backend operations (002/003/005) or be an explicitly local-only editor with all remote/office writes, approvals, provider claims and publication disabled. For that genuinely local-only build, HD-017's connected queue work remains disabled/deferred, while its local update/cache/save protections are mandatory. Never expose the current unauthenticated API as the local pilot backend. A private network alone is not authorization. Unsupported mobile editing may be explicitly unavailable, but mobile review must still be usable before it is advertised.

### Gate O — connected office production

Requires all applicable HD-001–042, all eight existing acceptance gates in `docs/29_ACCEPTANCE_GATES.md`, and its pilot exit. Optional WAHA/GPU integrations may stay disabled, with their conditional rows still visibly unimplemented. No critical security, factual, approval, source-loss or wrong-destination exception is waivable as “good enough.”

### Gate R — continued reliability

Every release rechecks critical contracts, old-source compatibility, security and visual goldens. Restore drills and production SLOs continue after launch. A later dependency/model/font change invalidates affected evidence until rerun. An observed silent loss or unauthorized publication pauses the affected capability immediately.

## 4. Complete task ledger

The short requirement lists below are primary anchors. `requirements-coverage.csv` assigns every existing FR/NFR to a task; assignment is **planning coverage, not proof of compliance**.

### HD-001 — Remove false success and establish capability truth

**P0 · Owner:** architecture/backend/frontend · **Depends:** none · **Requirements:** NFR-017, NFR-025, FR-064, FR-071.

Separate demo/test adapters from production composition. Missing credentials, unavailable storage, an unadmitted editor or unexecuted QA must return unavailable/blocked, not healthy/pass/complete. Remove hardcoded certificates, synthetic provider receipts, sample SLOs disguised as observations and fabricated frontend outbox/Drive paths. Show capability mode and last actual successful check. Keep useful demos explicitly labeled and unable to approve or publish.

**Proof:** run without every integration credential and with each dependency separately stopped; all affected actions fail closed with useful next steps. Inspect UI and API together. Reproduce P05/P06/P14 and package certificate behavior, then prove they cannot masquerade as real success. A production import-graph test rejects `@hawa/testkit`/fake adapters; legitimate deterministic local algorithms must identify themselves honestly. Attach mode matrix, startup logs and screenshot pairs.

### HD-002 — Authenticate and authorize all operations

**P0 · Owner:** security/backend · **Depends:** 001 · **Requirements:** FR-043, FR-069, NFR-006.

Use the selected trusted identity provider/session boundary; establish server-owned actor, tenant and role context. Authorize every read/write, SSE stream, source/asset download, admin setting, model action and workflow control. Restrict CORS to configured origins; address CSRF according to session transport. Remove default shared secrets from production configuration; prohibit self-declared roles and client-supplied `verifiedServerSide`.

**Proof:** route inventory mapped to anonymous, expired session, designer, reviewer, operator and administrator. P01/P02 become 401/403 or valid conflict/not-found responses as appropriate. Test direct API access bypassing the UI, revoked membership, guessed IDs, token expiry, browser cross-origin requests and stream reconnection. Supply raw authorization matrix results and no-secret logs. Test the deployed proxy boundary as well as in-process handlers.

### HD-003 — Enforce tenant/client/project boundaries end to end

**P0 · Owner:** security/database · **Depends:** 002, 005 · **Requirements:** FR-011, FR-021, FR-077, NFR-006/007.

Reconcile RLS context names with `db/rls.sql` (`app.*` versus current `hawa.current_*` mismatch). Fix policy/schema mismatches including `clients` lacking `client_id`. Set transaction-local context through safe parameterized operations; do not use a privileged owner role as the application. Protect API lists, retrieval, assets, caches, signed links, telemetry and SSE with the same scope. Scope locking must reject reassignment within an attempt.

**Proof:** real PostgreSQL using least-privilege production-equivalent role, two tenants with reused client IDs where schema permits, multiple projects and users. Attempt every cross-scope access/write, pooled-connection reuse, unscoped context and owner bypass. All unauthorized disclosures/effects = zero. Demonstrate authorized access still succeeds and cross-project knowledge is excluded. Attach SQL/RLS execution logs, role grants and API/stream results.

### HD-004 — Treat every imported file and rendered asset as untrusted

**P0 · Owner:** security/editor · **Depends:** 001 · **Requirements:** FR-068, FR-073, NFR-006/020.

Apply shared strict schemas and mature allowlist sanitization at upload, `.hyc` import, SVG/HTML preview, AI output and export boundaries. Reject executable markup, remote fetches, path traversal, oversized/decompression-bomb files, malformed numeric geometry, duplicate node IDs and unsupported versions. Decode images and verify real type/limits rather than trusting extensions. Avoid raw DOM injection; sandbox where needed. Preserve valid typography/vector fidelity and use a restrictive deployed CSP as defense in depth.

**Proof:** malicious and benign fixture corpus through the **real import and preview UI**, including HTML supplied in an SVG field, SVG events/foreignObject/external URLs, nested archives and invalid dimensions. Assert no script execution, unexpected network access, process escape or uncontrolled allocation. Attach browser traces and sanitized output diffs. Confirm rejected imports leave the previous document unchanged. Source inspection identifies unsafe sinks; do not call an untriggered exploit test proof of safety.

### HD-005 — Make PostgreSQL the real source of truth

**P0 · Owner:** database/backend · **Depends:** 001 · **Requirements:** FR-001/002/032, NFR-001/020.

Replace production `Map` stores with repositories wired to actual persistence. Reconcile TypeScript DB types and queries with authoritative SQL: current task `status`/event fields and `outbox` naming differ from schema `state`/`outbox_commands`. Define migrations, constraints, task versions, immutable revision records and atomic event writes. Validate configuration at startup. Do not acknowledge a task before its canonical state and required event/outbox transaction commit.

**Proof:** clean database migration, representative CRUD, constraints and repository contract suite against the actual DB—not parsed SQL or arrays. Re-run P04 through a real process restart. Inject rollback between task/event writes, concurrent updates and disk/database failures. Every acknowledged record survives; half-writes do not appear. Provide SQL counts, event ordering and restart traces. `db:check` must exit nonzero when a required live DB is unavailable or incompatible.

### HD-006 — Execute durable workflows through the real controller

**P0 · Owner:** workflow/backend · **Depends:** 003, 005, 007 · **Requirements:** FR-059–062, NFR-001/019.

Replace the worker's generic “ready” HTTP response with registered, versioned durable handlers. Persist checkpoints, retry classifications, scope and material dependency identities. Respect pause/cancel/replay authorization and audit reasons. Recover completed deterministic stages without repeating non-idempotent side effects. Do not advance to human approval when hard QA failed; distinguish retryable, blocked and permanent failure.

**Proof:** actual API/worker/controller/DB processes; kill each before work, during work, after durable commit and after a lost response. Restart in different orders. Verify exact recovered stage, preserved inputs and one logical side effect. Include cancellation during a provider call, exhausted retries and an operator replay. Attach durable journal, DB event sequence and end-to-end trace. Unit state-machine tests alone do not close this task.

### HD-007 — Transactional inbox/outbox and idempotency

**P0 · Owner:** database/integrations · **Depends:** 005 · **Requirements:** FR-004/047/049, NFR-001/020.

Use scoped unique event/command identities, request payload digests and atomic insert/state/outbox transactions. Same key/different payload must conflict. Fix message promotion duplication, race-prone check-then-insert, unlimited outbox leasing and absent lease recovery. Add bounded batch size, owner token, lease expiry, retry schedule and dead-letter/operator handling. Replaying a response must recheck authorization.

**Proof:** P03 regression; at least 1,000 duplicate deliveries over concurrent consumers, out-of-order edits and reused keys across tenants. Kill a lease holder; a new worker reclaims safely. Inject success-response loss at every external write boundary. Assert one logical task/publication/sheet identity and no lost command; allow transport retries without duplicate effects. Supply durable database assertions, not just request counts.

### HD-008 — Bind approval to the exact revision and QA

**P0 · Owner:** backend/security · **Depends:** 002, 003, 005, 009, 018 · **Requirements:** FR-041–044, NFR-015.

Require a real current revision, measured QA report, source/package hash and authorized reviewer. Derive identity on the server; append approvals immutably in a transaction. Reject nonexistent, foreign, stale, failed-QA and superseded revisions. Any material edit invalidates approval. Remove generic `approve` control bypasses. Human revision requests are not the same counter as the two automated repair cycles.

**Proof:** P02 regression plus approve/edit/publish races, two reviewers, changed hash, tampered role, altered QA, missing revision and replay. A post-approval edit cannot publish under old approval. Database update/delete attempts on approval ledger fail for application roles. Provide artifact-bound approval receipt, negative matrix and audit trail; screenshots are supplementary.

### HD-009 — Real hashes and deterministic identities

**P0 · Owner:** domain/platform · **Depends:** none · **Requirements:** FR-029/044, NFR-014/020.

Use actual SHA-256 over documented canonical serialized content and real artifact bytes. Replace 32-bit “sha256,” timestamp hashes, fake brand seals and partial-whitelist JSON canonicalization. Include all semantically material nested fields, assets and font identities; exclude only explicitly documented non-material metadata. Version canonicalization and distinguish content identity from authenticated provenance.

**Proof:** P15 regression; changing any material field changes digest, key ordering does not, stable input produces stable digest, and known SHA-256 vectors match independent tooling. Hash actual files after writes and read-back. Test tampered package entries and rollback to older schema versions. Attach canonicalization specification, test vectors and an independently verified manifest.

### HD-010 — Resolve the editor admission decision

**P0 · Owner:** architecture/editor lead · **Depends:** 001, 009 · **Requirements:** FR-028–030/075, NFR-008/019/025.

Execute `docs/21_HYCANVAS_PROOF_SPRINT.md`. Decide explicitly between admitted native HyCanvas through its adapter and the focused custom editor; do not mislabel one as the other. Record license obligations, pinned candidate, authoritative renderer, supported operations/formats and fallback. Keep adapter contracts stable. A static capability response or self-generated same-hash comparison is not admission.

**Proof:** clean installation and independent second instance; 40 synthetic and 20 real representative designs; edit/save/reopen/export every supported critical operation. Run interruption, concurrency, security and native language checks. P06 must fail for unknown documents. Produce executable admission report, actual source/render corpus, environment hashes and signed ADR: admit, patch-and-admit or reject. Conditional admission cannot enable an unproven critical feature.

### HD-011 — One complete canonical document model

**P0 · Owner:** editor/domain · **Depends:** 009, 010 · **Requirements:** FR-028/029/031/032/036, NFR-008/010.

Define schema versions, geometry units and migrations. Round-trip every supported property: groups, alignment, line height, letter spacing, shadows, borders, opacity, transforms, z-order, visibility, locks, crop, image/vector assets, text runs and locale. Preserve empty text and intentional zeros. Reject unknown required features rather than silently dropping them. Maintain stable IDs and immutable revision ancestry.

**Proof:** P12 regression plus property-by-property fixtures and randomized valid documents. Save/reopen/edit again on a fresh instance; semantic diff has zero unexplained loss. Import older versions and corrupt/truncated packages without altering the open document. Prove `.hyc` compatibility in native HyCanvas if claimed; otherwise use a documented honest custom format and migration/export route.

### HD-012 — Preview/export parity and complete delivery files

**P0 · Owner:** rendering/editor · **Depends:** 010, 011, 013, 014 · **Requirements:** FR-033/038/045, NFR-008/010/014.

Render from the canonical document rather than hardcoded headline/copy/logo templates. Apply transforms, groups, hidden/locked semantics, text wrapping, effects and asset cropping consistently in preview, PNG, SVG and any supported PDF. Handle alpha, sRGB/color profiles, scale factors and gradients correctly. Do not claim unsupported PDF/PPTX/PSD. ZIP delivery must contain real files, source, assets/fonts where licensed and manifest—not just metadata or file names.

**Proof:** P13 regression; each edit changes only intended output. Test every supported format at 1×/2×/4× with exact dimensions, actual file decoding, standalone offline opening and declared color/alpha behavior. Compare semantic content separately from rendered pixels under pinned fonts/renderer and reviewed tolerances. Include font-not-loaded, missing image, CORS-tainted image, huge canvas and canceled export. Reopen delivered source on a clean machine and verify all manifest byte sizes/digests.

### HD-013 — Professional Sorani/Arabic typography and fonts

**P0 · Owner:** typography/editor + two native reviewers · **Depends:** 010, 011 · **Requirements:** FR-034–037, NFR-009/022.

Bundle/version licensed fonts or managed uploaded fonts with glyph coverage checks; wait for font readiness before measuring or exporting. Correct mixed RTL/LTR runs, punctuation, digits, selections, caret movement, IME composition, paste and wrapping. Preserve approved copy; orthographic suggestions must not silently rewrite factual/approved text. Never rely on network font loading for final fidelity.

**Proof:** every `evals/rtl_golden_cases.jsonl` case plus 20 real office designs, including Drustee's `ڤیتامین D`, Latin dosage/units, URLs and approved Kurdish text. Test typing/deleting at bidi boundaries and compare preview/PNG/SVG/PDF where supported across supported browsers. Cold offline first open, missing glyph and wrong font must warn/block rather than certify. Two native reviewers sign critical visual/copy cases; attach font hashes/licenses and full-size exports.

### HD-014 — Asset integrity and optional external-editor handoff

**P0 · Owner:** editor/assets · **Depends:** 004, 009, 011 · **Requirements:** FR-026/027/037/045/075.

Store independently replaceable original images/vectors with provenance, license and digest; resolve links offline and after project transfer. Support only declared import/export types. Build a practical Drustee template with live headings/body text and separate bone/food/product imagery. External Photoshop work returns as named approved assets or a separately retained layered master; a flattened PNG is never described as a multilayer file.

**Proof:** relink/missing-asset tests, duplicate names/different bytes, replace-one-image locality, image orientation/transparency and licensed font packaging. Deliver a self-contained sample kit and open it on a clean browser/machine. Demonstrate documented Photoshop-optional handoff without losing the primary editable layout. If native PSD round-trip is not supported, say so explicitly and verify the fallback rather than claiming parity.

### HD-015 — Atomic saves, honest autosave and conflict recovery

**P0 · Owner:** editor/storage · **Depends:** 009, 011 · **Requirements:** FR-031/032, NFR-001/020.

Wait for IndexedDB transaction completion, not request success. Return explicit persisted/failed state; show saving, saved-at-revision, offline-local-only and unsaved errors. Close/manage connections and handle upgrades/blocked stores. Choose the newest verified fallback, not stale IndexedDB automatically. Scope drafts by actor/client/document. Add expected-revision server saves, conflict UI and recovery history; protect unsaved work during navigation and updates.

**Proof:** P11 regression; quota/full disk, denied storage, transaction abort after request success, stale fallback, malformed records, interrupted migration, tab crash and two-tab conflict. Kill/reopen during at least 100 save cycles per fault class in the isolated harness. Zero acknowledged-save loss or silent overwrite. A failed save retains recoverable in-memory content and offers a working local export. Provide revision/hash before-and-after records and browser trace.

### HD-016 — Reliable undo/redo and editing commands

**P0 · Owner:** editor · **Depends:** 011 · **Requirements:** FR-031/032, NFR-012/016/020.

Include every material document property in history equality and snapshots. Use explicit commands/transactions so one drag or IME edit is one coherent undo step. Fix stale React-state captures and branch behavior; retain stable selection. Bound history memory with tested checkpoints/compaction, not misleading “structural sharing” labels over repeated full JSON copies. Support predictable grouping, reorder, locking, duplication and keyboard cancellation.

**Proof:** P10 regression plus every property/operation undo→redo semantic equality; at least 1,000 mixed operations and branch/reopen scenarios. Test rapid drag, pointer cancel/window blur, modifier keys and text composition without accidental navigation. Check memory after repeated sessions and compaction. Attach command corpus, semantic snapshots and interaction recording; no unrelated edits may change.

### HD-017 — Safe offline queue and application updates

**P0 · Owner:** frontend/platform · **Depends:** 005, 007, 015 · **Requirements:** FR-001/060, NFR-001/007/017.

Persist the full task including client/project/copy/attachments before confirming queued state. Retain per-stage replay checkpoints and remove work only after the canonical server acknowledges the required workflow stage. Fix route replay missing `clientId` and ignored failure responses. Isolate cached data by authenticated scope, clear/revoke appropriately, and do not fabricate HTTP 200 empty data on outages. Coordinate service-worker updates with dirty documents; support cached deep links and pinned fonts/assets.

**Proof:** offline creation→reload→reconnect, 400 route, 500 brief, timeout generation, duplicate reconnect, expired auth and account switch. Task content is not lost or leaked and eventual replay is idempotent. Update the app while editing, then decline/accept update safely. Test cold offline versus previously cached behavior separately. Attach browser cache/queue state transitions and server event receipts.

### HD-018 — QA that genuinely blocks bad output

**P0 · Owner:** QA/rendering/backend · **Depends:** 009, 011–014 · **Requirements:** FR-015/027/038–040/045.

Fix missing brand findings in aggregate pass, missing-required-variant detection and package validation that does not inspect bytes. Validate exact copy, logo hashes, dimensions, clipping/overflow, glyph shaping, bidi, safe zones and actual files for every variant. Require a complete manifest from the renderer; absent evidence is unavailable/failed, not passed. Vision judgement is separate and cannot override deterministic failures. Bind reports to source/render/profile versions.

**Proof:** P07/P08 and C01 controls; mutate each critical property independently and prove failure propagates through API/UI/approval/publication. Missing pages, empty renders, absent files, wrong logos and flattened-only source must block. Negative controls removing each hard guard must make CI red. Provide defect corpus, precision/recall by defect class, original/mutated exports and report hashes. Tolerances are explicit and reviewed, never chosen to hide failures.

### HD-019 — Authoritative facts, Client DNA and Drustee templates

**P0 · Owner:** product/domain/content reviewer · **Depends:** 002/003 for shared mode; 009, 011 · **Requirements:** FR-013–017/027/078, NFR-007/014.

Separate approved facts/copy from suggestions and demo content. Replace old SEBAR sample branding with an approved Drustee kit only through a deliberate migration preserving stable IDs/history. Remove fabricated verification seals, contacts, prices and destination defaults from production templates. Version brand changes with validation, review, provenance and optimistic concurrency. Missing required facts must ask a question or leave an explicit draft placeholder and block final approval.

**Proof:** new blank brand cannot export a “verified” seal or invent a contact; missing-price/date/dosage fixtures remain missing. Changing one DNA color/asset invalidates relevant evidence. Drustee approved spelling/colors/logo/assets survive template→edit→export→reopen. A qualified human approves health claims separately from design QA. No medical authority is inferred from an attractive graphic or AI output.

### HD-020 — Real review, revision differences and safe actions

**P1 · Owner:** frontend/backend · **Depends:** 008, 011, 018 · **Requirements:** FR-041/042/052/063, NFR-016/017.

Show actual full-resolution candidate, original request, locked copy, sources, QA, version and semantic/visual differences. Comments target stable nodes; direct edits produce a new revision. Separate Save, Request changes, Approve and Publish where policy requires; disable impossible actions with explanation. Never optimistically display successful approval/publication. Retain errors and reviewer work when networks fail; remove fabricated standalone publication behavior.

**Proof:** routine review/revise/reapprove on desktop and mobile; stale tab, deleted node, failed save, failed publish, unauthorized role and double-click. The reviewer always knows which version is under review. Attach usability recording, actual backend receipts and hash-linked before/after comparison, not a demo dialog.

### HD-021 — Genuine verified Google publication

**P0 · Owner:** integrations/backend · **Depends:** 007–009, 012, 018 · **Requirements:** FR-045–049, NFR-020.

Implement the provider against sandbox then approved office destinations from Client DNA. Upload actual package bytes, use stable identities, read back file metadata/checksums or content verification where supported and check permissions. Upsert Sheets by immutable row identity. Persist partial progress and reconciliation requirements; inspect `Result.ok` before state advancement. Never default another client's work to the office folder.

**Proof:** P05 regression; real sandbox service identity with least privilege; three clients with distinct folders/sheets. Missing permission, full/quota, wrong destination, partial upload and lost-success response produce honest states. Each task/revision has exactly one logical package/row after retry. Download/open source and verify every file digest/size; attach redacted provider IDs, read-back logs and DB receipts. Actual credentials/destination approval are required to close this task.

### HD-022 — Reconciliation and notifications that converge

**P1 · Owner:** integrations/operations · **Depends:** 021, 007 · **Requirements:** FR-050/051/071.

Compare persisted expectations to actual Drive/Sheet observations, not hardcoded fixtures. Detect missing/changed files, missing/duplicate rows and permission drift; classify safe repair versus operator decision. Notification failures retry independently and cannot roll back verified publication. Schedule and observe reconciliation with scoped audit logs and explicit repair authorization.

**Proof:** seeded sandbox drift in each class; run reconciliation repeatedly and show convergence without duplication or cross-client writes. Simulate notification outage after upload success. Attach before/after provider state, repair audit, repeat-run no-op results and operator escalation screenshot. Never automatically delete externally modified customer files without policy and authority.

### HD-023 — Honest, bounded and policy-enforced AI gateway

**P0 before AI enablement · Owner:** AI/platform/security · **Depends:** 001–003, 009 · **Requirements:** FR-056–059/065–068/079.

Resolve admitted exact models from the registry; do not silently rewrite requested model IDs while reporting the original. Enforce allowed providers/local-only policy, deadlines, input/output limits, schemas, concurrency and spend before each attempt. Handle HTTP errors as errors and only use evaluated permitted fallbacks. No-image/no-provider vision calls cannot pass. Record real provider usage or clearly labeled estimates and actual provenance; don't record fixed token counts as measured usage.

**Proof:** P14 regression; mocked fault contracts plus real authorized small sandbox calls per enabled provider. Test 401/429/500, malformed JSON, schema violation, timeout, refusal, fallback egress prohibition, budget exhaustion and cancellation. Assert no prohibited network call occurs; record exact request model versus response model, cost evidence and redacted trace. Provider/model selection remains unadmitted until HD-040 evidence exists.

### HD-024 — Real scoped retrieval and ingestion

**P0 before knowledge-assisted generation · Owner:** retrieval/database · **Depends:** 003, 005, 009, 019 · **Requirements:** FR-018–023, NFR-005/007.

Parse real approved source bytes with provenance; remove sample-content ingestion. Filter tenant/client/project/approval/version/polarity before ranking and in authoritative context construction. Implement the agreed hybrid search/reranking path or explicitly narrow the advertised capability; fabricated vector scores are not retrieval. Handle conflicting facts, stale/deactivated sources, requested topK and no-match abstention.

**Proof:** P09 regression plus reused client IDs across tenants, unapproved/negative examples, conflicting rules, stale documents and cross-project authoritative assets. Use frozen labeled real-content fixtures; report recall/nDCG and downstream factual errors with no leakage. Inject malicious document instructions and prove they cannot change scope or destinations. Record actual source digest→chunk→context citations and retrieval timings.

### HD-025 — Editable generation, variants and bounded repairs

**P1 before generation enablement · Owner:** creative/editor/AI · **Depends:** 011–014, 018, 019, 023, 024 · **Requirements:** FR-016/024–026/033/039/040, NFR-018.

Use templates for routine work; do not call expensive models unnecessarily. For novel work generate a validated editable plan and separate reusable assets, not baked-in factual copy. Reference pixels remain private and never ship. Apply commands through the adapter with expected revision. Preserve per-variant overrides and local user edits. Limit automated repair to two cycles, with honest human escalation and cancellation.

**Proof:** template/no-AI network assertion, novel plan with artifact lineage, independently replaceable assets and multiple real aspect ratios. Stress long copy, small canvases, missing logos and stale operations. Confirm no negative geometry, unrelated regeneration or reference pixels in final assets. Third automatic repair attempt blocks; human edits remain possible. Attach source/asset lineage and variant-specific diffs.

### HD-026 — Feedback and brand-rule governance

**P1 · Owner:** domain/backend · **Depends:** 005, 008, 019, 020 · **Requirements:** FR-052–055/069.

Persist structured correction/approval/rejection/manual-edit events. Separate one-time feedback from proposed reusable rules. Require authorized activation/versioning and conflict resolution; do not silently learn client truth from model summaries. Promote important failures into regression fixtures with provenance and privacy controls.

**Proof:** one-time note stays local, repeat feedback produces only a candidate rule, unauthorized activation fails, accepted rule affects only intended scope, retirement restores prior behavior where specified. Attach append-only ledger evidence, rule diff, approval identity and replayed regression case.

### HD-027 — Reliable manual intake and messaging adapters

**P1 · Owner:** frontend/integrations · **Depends:** 002, 003, 005–007, 019 · **Requirements:** FR-001–014/071.

Complete manual intake fields, validation, attachments, exact-copy preservation and due/client/project selection. Retain raw normalized event/edit/thread context under policy. Verify adapter signatures/secrets; support replay protection and sequence gaps. Passive messages do not automatically become tasks outside approved promotion policy. Route deterministically first; ambiguous or unauthorized candidates require human selection before retrieval. Correcting client routing invalidates downstream attempts/artifacts safely.

**Proof:** real enabled messaging sandbox plus direct Desk flow; duplicate/reordered events, wrong secret, expired replay, edited message, missing attachment, ambiguity and wrong-client correction. Exactly one logical task and preserved source lineage. Routing model never sees disallowed clients. Attach webhook receipts and blocked-state screenshots. Unused channels remain disabled, not falsely healthy.

### HD-028 — Isolate optional GPU and WhatsApp execution

**Conditional, P0 before enablement · Owner:** platform/security · **Depends:** 002, 003, 023, 030 · **Requirements:** FR-062/072–074.

Keep WAHA and ComfyUI disabled until specifically needed and admitted. If enabled, use dedicated service accounts, allowlisted pinned workflows/nodes, isolated network/filesystem resources, limited egress, bounded GPU queues and a kill switch. No office database credentials in GPU workers; no arbitrary model-generated execution graphs. Channel/platform policy review is separate from technical functioning.

**Proof:** network/credential boundary tests, rejected unknown graph/node, malicious upload, worker termination, queue saturation and kill-switch recovery. Record container/workflow/model digests and narrow grants. If deferred, demonstrate disabled endpoints/UI and no background traffic; mark CONDITIONAL-DISABLED, not DONE for the feature requirements.

### HD-029 — Actionable operations and truthful telemetry

**P1 · Owner:** operations/frontend · **Depends:** 001, 005–008, 021–024 · **Requirements:** FR-061/063–065/071, NFR-011/017.

Replace synthetic health/SLO evidence with measured dependency probes, durable task stages, retries, backlog age, failure class and last success. Keep synthetic monitoring clearly separated. Every failed task exposes sanitized context, trace ID and one safe next action. Authorized pause/replay/cancel requires reason and creates audit. Health freshness is explicit; liveness and readiness are distinct.

**Proof:** break each dependency and watch correct degraded state/alert/action; restore it and verify recovery without losing work. Follow one real task across ingestion→model→editor→QA→approval→publication. Test redaction with synthetic sensitive strings and unauthorized trace access. Attach traces, alerts, state timeline and operator walkthrough.

### HD-030 — One reproducible, secure deployment

**P0 before server deployment · Owner:** platform · **Depends:** 002, 003, 005, 006, 032, 039 · **Requirements:** FR-074, NFR-006/013/023.

Reconcile `deployment/` and `infra/docker/` into one supported deployment contract. Pin immutable images/runtime/package manager; align actual artifact paths and entrypoints with builds. Require secrets/configuration rather than insecure defaults. Serve through protected TLS/office/VPN ingress, non-root identities and least-privilege volumes/networks. Readiness must verify required DB/controller/studio compatibility; migrations run in an explicit safe stage.

**Proof:** clean machine with documented prerequisites, frozen install/build, real container startup and authenticated browser workflow. Verify no missing `dist/*.mjs`, no exposed DB/admin ports and no default credential acceptance. Stop required dependencies: readiness fails. Upgrade and roll back a candidate with old documents retained. Attach artifact manifest, image digests, redacted topology and installation transcript. Do not use a parsed Compose file as deployment proof.

### HD-031 — Real encrypted backup and clean-host restoration

**P0 before relying on stored work · Owner:** operations/database · **Depends:** 005, 011, 030 for office mode · **Requirements:** FR-070, NFR-003.

Replace the misleading schema-concatenation drill as production evidence. Reuse and complete the guarded `deployment/backup.sh` / `restore-test.sh` foundation: actual DB/WAL, source/assets/fonts/configuration, required durable-controller state and separate key recovery. Verify encryption, retention, failure alerts and destination access. Restore only to validated isolated targets; never run destructive drills on live work.

**Proof:** add unique canary task/source and edits after backup; restore to a genuinely empty isolated host, open representative designs and compare hashes, recover users/permissions and resume a paused workflow safely. Reconcile actual sandbox publication. Measure database RPO ≤15 minutes and core RTO ≤4 hours as existing spec targets. Local editor pilot additionally needs independent external source/asset backup and successful reopen; browser storage alone is not backup. Attach timestamps, manifests, restored UI and operator sign-off.

### HD-032 — CI and tests that cannot certify the wrong thing

**P0 · Owner:** test/platform · **Depends:** establish immediately, expand with every task · **Requirements:** NFR-012/024/025.

Install the real CI workflow in the platform's executable location; `infra/ci/github-workflow.yml` alone is not GitHub Actions. Make lint genuinely analyze all intended source, typecheck/build use the same project graph, and declare Python/YAML prerequisites. Distinguish unit/static checks from live integration/browser/restore/admission gates. Remove fixed success totals and “all gates verified” echoes. Pin dependencies and upload raw evidence even on failure.

**Proof:** clean checkout runs lint/typecheck/unit/contracts/real DB/workflow/browser/export/RTL/fault suites appropriate to the gate. Deliberately break auth, persistence, export parity and approval in disposable branches: each corresponding required gate becomes red. Required tests cannot skip-green on absent DB/credentials; classify BLOCKED explicitly. Verify artifacts downloadable from actual CI and stale artifacts cannot satisfy a newer commit. Keep deterministic fake tests, but label them honestly.

### HD-033 — Measured editor responsiveness and resource budgets

**P1 · Owner:** frontend/performance · **Depends:** 011, 012, 015, 016 · **Requirements:** NFR-004/005/016.

Profile before optimizing; reduce full-tree copies, unnecessary rerenders, synchronous heavy exports and leaked listeners/object URLs/DB connections. Define small/medium/large supported documents from real Drustee/office assets. Run long tasks off the interaction path where appropriate and provide cancelable progress. Fit-to-view and zoom should be mathematical, stable and reversible.

**Proof:** freeze office hardware/browser/fonts and workload. Measure p50/p95/p99 open/save/export, pointer-to-paint, frame intervals, memory and CPU over ≥30 runs per size; a ≥2-hour editing soak and repeated open/close cycles must show no unbounded retained growth. Record raw profiles, not only averages. Adopt calibrated budgets before acceptance; suggested investigation targets are ≤50 ms p95 direct-manipulation response and no persistent input-blocking long tasks. These are proposed product targets, not measured results or existing-spec amendments. Preserve the existing API latency targets. Do not use synthetic SLO counters as this proof.

### HD-034 — Responsive workspace and usable mobile review

**P1 · Owner:** frontend/design · **Depends:** 020 where connected · **Requirements:** FR-041/076, NFR-016/021.

Fix the observed 1,041-pixel page on a 390-pixel viewport. Replace fixed desktop sidebars/panels with responsive drawers or tabs; reserve canvas panning for the canvas, not the whole page. Keep main actions and current revision visible. At smaller widths provide a focused review experience; do not squeeze the full desktop tool into an unusable strip. Preserve state when panels or orientation change.

**Proof:** 320, 390, 768, 1024, 1440 and 1920 widths; portrait/landscape; 200% zoom and reflow checks. No unintended whole-page horizontal overflow, clipped actions or overlapping panels. Actual phone/tablet review plus supported desktop browsers; screenshots and task-completion recordings. Use current desktop/mobile audit captures as the starting regression cases.

### HD-035 — Accessibility as a complete workflow

**P1 · Owner:** frontend/accessibility reviewer · **Depends:** 034, 036 · **Requirements:** FR-076, NFR-021/022.

Meet WCAG 2.2 AA for supported operational journeys. Provide semantic landmarks, meaningful control names, visible focus, correct dialogs/menus, status announcements, field labels/errors and contrast. Expose layer order/selection/geometry in keyboard/screen-reader-accessible controls, not canvas alone. Avoid single-character shortcuts intercepting text/assistive input; make shortcuts discoverable and adjustable. Respect reduced motion.

**Proof:** automated accessibility report plus manual keyboard-only creation/edit/save/review and VoiceOver testing on the supported platform; add other assistive combinations if claimed. Check 200% zoom, reflow, touch targets, focus restoration, drag alternatives and high contrast. No critical/serious automated issues and no manual journey blocker; remaining WCAG criteria require explicit assessment, not a blanket scanner certificate. W3C AA target-size minimum is 24×24 CSS pixels with exceptions; use larger ~44-pixel touch areas where practical as an ergonomic product target, not a false universal AA rule.

### HD-036 — Consistent professional interaction and visual finish

**P1 · Owner:** product design/frontend · **Depends:** 001, 011, 015, 016 · **Requirements:** FR-063/076, NFR-016/017.

Keep the useful canvas/layers/inspector structure but simplify dense competing controls. Establish shared spacing/type/color/focus/disabled/loading/error tokens and consistent iconography. Prefer clear stable controls over assorted emoji badges and permanent “certified” decorations. Create/select/edit/save/export must have predictable reversible outcomes. Loading, empty, unavailable and retry states are designed as carefully as success. Motion is brief, purposeful, interruptible and reduced-motion compatible; never delay repeated editor commands for animation.

**Proof:** reusable component/state inventory; before/after desktop/mobile screenshots and pointer/keyboard recordings. Five representative operators complete create→edit→recover→export→review scenarios without moderator rescue for critical actions. Record errors/time/confusion, resolve major issues, retest. The founder approves Drustee typography/legibility at actual phone size. A beautiful screenshot does not close behavior or integrity tasks.

### HD-037 — Capacity, backpressure and real SLOs

**P1 · Owner:** platform/performance · **Depends:** 005–007, 029, 030 · **Requirements:** FR-062/079, NFR-002/004/005/011.

Bound provider/GPU/render/publish concurrency, attachment sizes, queues, SSE buffers and retry storms by office/client/task. Implement graceful overload, cancellation and fair scheduling. Measure real availability/latency/error budgets with exclusions documented; keep synthetic checks separate. Paginate/search server-side and load-test production-like indexed data.

**Proof:** existing scale profile—100 clients, 100,000 tasks, 2 million chunks, 25 concurrent users and controlled workflows—on declared hardware, or approved explicitly narrower initial scope without claiming full-spec completion. P95 task list ≤1.5 s, webhook acknowledgement ≤1 s, non-AI transitions ≤2 s. Load spikes and slow providers do not lose acknowledged work. Attach raw load distributions, DB query plans, queue/retry traces and real monitoring configuration; 99.5% monthly availability needs a measured observation window, not a short test.

### HD-038 — Retention, safe deletion and data portability

**P1 · Owner:** backend/security/product · **Depends:** 003, 005, 009, 017 · **Requirements:** FR-066/067/069/080, NFR-007/010/015.

Enforce retention and egress policy per client; define attachment/source/trace/cache/backups lifecycle. Soft-delete with undo/retention where required, protect audit records, and require privileged explicit purge. Export operational data in documented portable formats. Sign-out and membership revocation must not expose prior client's cached content. Explain backup-retention limitations honestly.

**Proof:** scoped export and re-import/inspection, delete/restore/purge authorization, retention clock tests, signed-link expiry and account-switch offline cache tests. Verify no secrets or unrelated clients in exports/logs. Attach data-lifecycle matrix and purge/audit evidence from synthetic fixtures only; never test permanent deletion on user production records.

### HD-039 — Supply-chain and security release verification

**P0 before deployment · Owner:** security/platform · **Depends:** 002–004, 030 for deployed checks · **Requirements:** FR-068/074, NFR-006/013.

Inventory reachable attack surfaces and dependencies; perform secret detection, dependency/container scans, static security checks and targeted dynamic testing. Generate a valid SBOM with a known non-recursive command and verify licenses. Pin critical dependencies/digests and document upgrade/canary/rollback policy. Review credential storage, log redaction, rate limits and default configuration. A regex secret scan is not an application security audit.

**Proof:** versioned ASVS-based applicability matrix, real scanner reports and triaged reachable risks. No unresolved critical/high exploitable issue in enabled scope without remediation; foundational auth/isolation failures are not waivable. Attempt direct API/proxy/upload boundaries in an isolated deployment. Validate SBOM against the built artifact and test revoked credentials. Independent reviewer signs scope and findings; do not claim OWASP certification merely by referencing the standard.

**Current lead:** the audit's production-dependency scan reports three high-rated Kysely 0.27.6 advisories. Triage actual dialect/API reachability (some are MySQL/SQLite-specific; this project uses PostgreSQL), then upgrade with database compatibility tests. Do not call package-level advisories confirmed application exploits. The static/dependency review can precede HD-030; final deployed dynamic verification follows it, avoiding a circular deployment gate.

### HD-040 — Real model/editor quality evaluation and admission

**P1 before primary AI roles · Owner:** evaluation lead + human reviewers · **Depends:** 010, 013, 018, 023–025 · **Requirements:** FR-039/055–058, NFR-009/025.

Use the existing frozen 200-task tournament requirement with representative Sorani/Arabic/English, template/novel, ambiguity, factual and adversarial cases. Separate deterministic workflow tests from model quality. Actual provider runs, blind human design preference and holdout safety decide primaries/fallbacks; no fixed visual scores or fake gateway as real-provider evidence. Record stochastic repeats, uncertainty, latency and actual costs. Evaluate upgraded fonts/renderers/models on held-out cases before canary.

**Proof:** dataset hashes, train/dev/holdout separation, actual invocation IDs and response evidence, per-case outputs, blind review forms and aggregated reproducible metrics. Critical factual and cross-client escapes = zero in admission cases; that does not imply zero future error. Report failures, sample limits and fallback degradation. Two native reviewers for critical text; named authorized admission decision and tested rollback. Never buy expensive runs without an approved evaluation budget.

### HD-041 — Real office pilot and release decision

**P1, final admission · Owner:** founder/operations/release lead · **Depends:** all enabled production tasks · **Requirements:** existing `docs/29_ACCEPTANCE_GATES.md` pilot exit, NFR-016/025.

Run the local Drustee rehearsal first, then the existing office pilot: three representative clients and at least 100 production tasks. Do not silently relabel synthetic seed traffic as production. Observe content accuracy, source fidelity, user errors, recovery, revision burden, publication verification and technical rescue. Keep feature rollback available. If business scope is now Drustee-only, obtain an explicit revised pilot/scope decision; this audit does not waive the broader contract.

**Proof:** source/brief/QA/approval/publication bundle for each task; ≥95% complete without technical rescue; zero critical security/factual/editability escapes; demonstrated runbook use and explicit management acceptance of bounded remaining risks. Attach task ledger, incidents, human feedback, evidence completeness report and signed release decision. A single “looks good” review or 100 fabricated tasks cannot close the pilot.

### HD-042 — Evidence ledger, operator handover and final audit

**P1 · Owner:** release/test lead · **Depends:** all tasks applicable to claimed release · **Requirements:** NFR-012/016/025 and all mapped requirements.

Maintain task status, requirement links, proof artifacts and dependency freshness. Write concise setup, daily design, save/recovery, offline, approval, publish, update/rollback and incident guides. Clearly list supported browsers/devices/formats/languages, limitations and when Photoshop is optional. Reconcile misleading old completion documents without erasing history. Deliver a one-command verification entrypoint that distinguishes real passes, failures and blocked external proofs.

**Proof:** independent clean-checkout rerun validates all required evidence hashes and detects a missing/stale receipt. A non-author operator follows setup and recovery guides successfully. Final report lists each task/requirement PASS, FAIL, BLOCKED or explicitly DISABLED; no unexplained gaps. Founder receives release tag, backup/recovery instructions, sample delivery kit and known limitations. **Do not mark this sheet complete until the evidence—not the narrative—supports it.**

## 5. Focused Drustee rehearsal before trusting Hawdesign-first

Use one approved Vitamin D master, then Omega-3 and Vitamin C variants with independently reviewed factual copy. This is a design-tool test, not medical approval.

1. Import/create separate bone/food/product imagery and live Kurdish/Latin text. Confirm Drustee branding and prominent, correctly ordered `D`.
2. Change heading, text alignment, line height, spacing, group, shadow, crop, color, opacity and layer visibility. Undo/redo each; move the main headline.
3. Save, close the tab/browser, reopen, duplicate to square/feed/story and preserve intended overrides.
4. Export actual PNG/SVG and supported source/package; reopen the package on a clean offline browser or second machine with no preinstalled project fonts/assets.
5. Compare source semantics, approved text and actual rendered output; inspect at phone size and full resolution. Verify no missing assets or flattened factual text in the editable master.
6. Force failed save, interrupted export and missing font. Confirm honest unsaved/blocked states and safe recovery.
7. Two native reviewers inspect Sorani; founder signs visual quality. Retain actual deliverables and evidence, not screenshots alone.

Only after this rehearsal and Gate L should Hawdesign become the primary tool for the admitted work. Photoshop remains optional for deliberately unsupported specialist tasks—not an invisible rescue needed to make every export usable.

## 6. Standards informing the acceptance approach

- Scope security verification using a versioned, applicable [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) control matrix; selected controls do not amount to independent certification.
- Review operational UI against [WCAG 2.2](https://www.w3.org/TR/WCAG22/), with the precise [target-size minimum and exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Follow [Apple's motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion): purposeful, brief, optional and interruptible animation—not decorative delays on frequent commands.
- [INP guidance](https://web.dev/articles/inp) considers ≤200 ms good at the 75th percentile. Use it for appropriate user interaction observations; it does not replace direct canvas drag/frame profiling or justify a fabricated performance score.

Sources reviewed 5 September 2026. Internal specification thresholds remain authoritative unless explicitly changed by an approved scope/architecture decision. Future implementation must consult the exact pinned versions it actually uses.
