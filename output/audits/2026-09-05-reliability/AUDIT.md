# Hawdesign deep reliability audit

5 September 2026 · Audited project: `/Users/hawzhin/Hawdesign`

## Verdict

**Hawdesign is not yet a trustworthy production design/office system, and should not currently be treated as a proven Photoshop replacement.** It contains a useful interactive editor and considerable specification/domain/test scaffolding, but critical production paths are simulated or insufficiently protected. The immediate work is correctness and trust—not additional decorative UI.

This conclusion is supported by executed negative probes, source inspection and real browser observation. It is not an arbitrary numerical score. No assessment can guarantee absolute 10/10 perfection; the meaningful target is reliable behavior in a declared scope, supported by repeatable evidence and continued monitoring.

The implementation plan is [TASK_SHEET.md](TASK_SHEET.md): **42 task packages**, all initially OPEN, with owners, dependencies, requirements, specific acceptance/failure tests and mandatory proof receipts. [requirements-coverage.csv](requirements-coverage.csv) maps all 105 existing requirements to planned work; it does not assert 105 requirements have been verified.

## Scope and evidence quality

- Read the project instructions, master contract, specification, acceptance/editor-proof/testing/UI documents and requirements; traced important runtime paths in Core, Worker, editor, exports, storage, history, QA, retrieval, model gateway, publisher, repositories, deployment, backup and CI.
- Executed the current repository test suite, typecheck, lint, Desk build, static DB checker, spec-pack validator and pattern-based secret scanner. Preserved raw logs and source fingerprints.
- Ran **16 isolated source probes: 15 violations reproduced and one positive control behaved correctly**, with no execution errors and no external provider calls. These are deliberately targeted cases, not a statistical failure rate for the whole application.
- Inspected the real development editor in fresh Chrome contexts at 1440, 1024 and 390 widths; captured screenshots and keyboard focus samples. Remote font requests and all state-changing API requests were blocked. This tests fallback/loading resilience, not the fully online final typography.
- Executed a harmless imported-markup browser probe in a fresh isolated context; it set a local window flag only. No data extraction, provider calls or real application task writes were performed.
- Existing backend on port 3001 was not restarted or mutated. A separate loopback-only Vite instance on 5187 served source for inspection. The existing running application's deployment/hardening was not assumed equivalent to the inspected source.
- Did not run live DB migration, real crash recovery, external Google publication, paid model tournament, destructive restore/purge, independent penetration testing, screen-reader testing, native Sorani sign-off or long performance soak. These remain explicit task gates, not implicit passes.

The worktree changed concurrently. Initial HEAD: `2d3515ef1b95b7e4433bc5fca526d80f5c1f171f`. Evidence applies to captured file hashes/timestamps, not a permanent claim about later edits. Initial modified export/UI work was preserved; source and final-check manifests identify drift. This audit authored only audit artifacts and memory updates, not app fixes. Compiler diagnostics may update generated build metadata; that is not a source fix.

## Executed results

### Repository checks

| Check | Initial result | What it actually establishes |
|---|---|---|
| Unit/fixture suite | 241 tests in 37 files passed | Existing assertions pass; no broad browser/DB/provider admission follows |
| Typecheck | Failed | During concurrent UI work, DnaScreen had unused declarations and undefined `setSuccessNotice` |
| Desk production build | Failed | Same current TypeScript errors; later changes require a fresh build |
| `lint` | Passed | Root script is `tsc --noEmit` with `files: []`; it did not catch the project-reference build failure and is not genuine lint coverage |
| Pack validation | Blocked/exit 1 | Selected Python lacked PyYAML; not evidence that the specification itself failed |
| DB check | Passed, static only | No live database was checked; code also catches live connection failure and can still report valid |
| Security scan | Passed | Only the scanner's secret patterns found no match; not auth/XSS/dependency security assurance |
| Targeted source probes | 15 violations + successful control | Specific reproducible defects below |

See [checks.json](checks.json), [logs](logs), and the later [final-checks.json](final-checks.json)/[final-logs](final-logs). The initial failure logs are intentionally retained even if concurrent changes later make a check green. Use the latest recorded run for current build status; neither run constitutes release admission.

**Later recheck, 13:38 Baghdad:** all 241 tests, typecheck and Desk production build passed after concurrent changes. The PyYAML prerequisite remained unavailable. The important source-probe defects were not repaired by this audit. Build failures are therefore recorded as an earlier transient state, not a current unresolved compiler claim.

**Dependency scan:** `pnpm audit --prod --json` returned three high-rated advisories for installed Kysely 0.27.6, not three proven exploitable application vulnerabilities. The [first upstream advisory](https://github.com/kysely-org/kysely/security/advisories/GHSA-wmrf-hv6w-mr66) expressly excludes PostgreSQL's normal operator path; the [second is MySQL-specific](https://github.com/kysely-org/kysely/security/advisories/GHSA-8cpq-38p9-67gx); the [third concerns JSON-path traversal](https://github.com/kysely-org/kysely/security/advisories/GHSA-pv5w-4p9q-p3v2). Hawdesign selects PostgreSQL. Record affected API/dialect reachability and upgrade compatibility under HD-039 rather than claiming a reproduced database exploit. The raw report is in `final-logs/dependency-audit.log`; dev dependencies and containers were not included in this scan.

### Direct probes

Full reproducible inputs/outputs: [probes.ts](probes.ts), [probes.json](probes.json). A later [probe rerun](probes-final.json) at 13:41 Baghdad reproduced the same 15 violations with no execution errors.

| Probe | Observed result | Required work |
|---|---|---|
| P01 | Anonymous task POST returned 201 and created a task | HD-002 |
| P02 | Nonexistent revision accepted as an approval; caller-supplied admin identity returned `verifiedServerSide: true` | HD-002/008 |
| P03 | Repeated promotion of the same event/key produced different task IDs | HD-007/027 |
| P04 | Acknowledged task returned 404 in a new `createApp()` instance | HD-005/006; this is re-instantiation evidence, not a host-crash experiment |
| P05 | Google publisher returned complete/verified with zero network calls and a nonexistent input file | HD-001/021 |
| P06 | Unknown studio document passed “round-trip” with the caller's arbitrary hash | HD-001/010 |
| P07 | Missing official logo failed its subcheck but overall QA still returned `criticalPass: true` | HD-018 |
| P08 | A manifest with no pages passed despite a required variant | HD-018 |
| P09 | An unapproved rule from another project appeared in authoritative context | HD-003/024 |
| P10 | Changing only a node's font size did not create a history position | HD-016 |
| P11 | IndexedDB unavailable plus localStorage quota failure still resolved the save promise | HD-015 |
| P12 | `.hyc` round-trip lost group, alignment, shadow, line height and letter spacing; package declared `CERTIFIED_PASS` | HD-001/011 |
| P13 | Moving or hiding the main headline produced unchanged SVG | HD-012 |
| P14 | Unavailable vision provider/no image returned a passing 9.7 judgement and fixed usage | HD-001/023/040 |
| P15 | Canonicalization used in DNA hashing ignored a nested color change, giving equal digests | HD-009; replicated the exact hashing expression, not an API version-update test |
| C01 | Missing approved exact copy correctly failed QA | Positive control; retain and expand |

### Browser results

- Desktop 1440×1000: editor rendered without uncaught page errors. Layers/canvas/inspector are a useful foundation.
- Laptop 1024×768: document width 1041 px, causing unintended horizontal overflow.
- Mobile 390×844: document width **1041 px**. A 240-pixel navigation sidebar and desktop controls crowd out the canvas; this is not usable mobile review.
- The UI still displays confidence-inducing verification/status labels that the runtime evidence does not support. These must become measured status or explicit demo/unavailable labels.
- External fonts were deliberately blocked; the headline fell back to a visibly different typeface. Final typography/export must not rely on font availability luck. No claim of a full multilingual visual review is made here.
- Basic name/focus sampling found labels/titles on buttons, but this is not an accessible-name computation or complete WCAG audit. Dense layer controls, focus behavior, zoom/reflow and screen-reader workflows need HD-035.

Screenshots: [desktop](desktop.png), [laptop](laptop.png), [mobile](mobile.png). Raw observations: [browser.json](browser.json). These are development-state captures, not final release visuals.

**Imported markup execution confirmed:** a `.hyc` node's `svgContent` accepted HTML containing an image error handler, and the real editor executed it, setting the harmless local flag. The first SVG-onload attempt did not trigger; an HTML-in-SVG-field error-handler case did. See [browser-import-probe.cjs](browser-import-probe.cjs) and [result](browser-import-probe.json). This confirms an unsafe import/render boundary in the tested development editor. A separately configured production CSP may affect exploitation, but must not substitute for safe parsing/sanitization. HD-004 is a release blocker.

## Source-level findings and root causes

Line numbers are navigation anchors as inspected; concurrent edits may move them. The named symbol and captured source hash are the durable reference.

### A. Backend identity, persistence and approvals — critical

`apps/core/src/app.ts` uses in-memory maps for tasks, events, briefs, revisions, decisions, DNA and uploaded assets (around lines 96–114). Normal task/admin/review routes have no demonstrated authenticated membership boundary; a Telegram webhook secret check does not protect them. Broadcast subscribers are not scoped by client in the inspected path. CORS accepts any origin. `apps/core/src/index.ts` binds its server without a loopback host restriction; the existing local port 3001 was observed listening on `*`. No internet reachability assessment was performed.

The decision route (`/tasks/:taskId/revisions/:revisionId/decisions`, around line 1206) trusts body identity, fabricates source/QA hashes and appends the decision before successful state validation. The generic task-control approval path provides another bypass. The system must not accept approval based merely on a task being in a particular state.

`apps/worker/src/index.ts` answers generic HTTP requests with “ready,” rather than registering the promised durable handlers. `workflow.ts` is an in-memory runner and does not establish recovery across processes. Restart safety is an architectural task, not just adding retries.

### B. Database implementation differs from its schema — critical before activation

`packages/db/src/repositories/task.repository.ts` inserts/updates `status`, source/idempotency fields and event shapes inconsistent with `db/schema.sql`, whose tasks have `state`, required title and different event columns. `outbox.repository.ts` targets `outbox` while SQL defines `outbox_commands`; its `leasePending(limit)` ignores the limit and lacks expiry/owner recovery.

`packages/db/src/client.ts` sets `hawa.current_*` session values while RLS reads `app.tenant_id`/`app.user_id`. The RLS generic client-policy loop includes `clients` but refers to `client_id`, absent from that table. These are direct source/schema inconsistencies. Their exact runtime errors were **not executed against PostgreSQL in this audit**; production-equivalent migration/RLS/repository tests must close them. Current static table-count checks cannot do that.

### C. Studio and publication adapters are not real operational proof — critical

`packages/integrations/src/hycanvas-adapter.ts` stores documents in a map, uses a small integer hash labeled SHA-256, imports an empty page instead of source content, and returns metadata for exports/renders without producing those files. `verifyRoundTrip` returns true by comparing a hash to itself. Capability claims are static. Generated manifests omit geometry/style needed for substantive QA.

`google-publisher.ts` constructs Drive IDs/links, expected sizes, a fixed sheet row and complete receipts in memory without contacting Google or reading input bytes. Core publication uses default-office destination data and does not establish verified artifact delivery. Frontend `ReviewScreen.handleApprove` also fabricates standalone workflow/outbox/Drive receipts. These are useful demo behaviors only if explicitly isolated; currently their presentation is stronger than their evidence.

### D. Local editor/export safety — critical for Hawdesign-first use

`canvasExport.ts` has separate hardcoded drawing paths and incomplete node serialization. P12/P13 verify loss/drift even with the concurrently added ZIP bundler. The package's `qualityAudit` unconditionally claims certification, contrast and safe zones. New bundle functionality does not itself repair renderer/source fidelity.

`historyTree.areStatesEqual` omits node font size, weight, alignment, spacing, shadow and other properties. History uses full JSON snapshots, so claims of structural sharing should be qualified until profiling/implementation supports them.

`draftStorage.persistWorkingDraft` resolves on a write request rather than transaction commit, silently falls back and ultimately logs/swallow failures. Its digest omits material content. `loadWorkingDraft` can prefer stale IndexedDB over a newer fallback. `draftStore.flushQueuedTasks` omits client ID in routing, ignores later HTTP failures and removes a task from the queue after creation anyway.

The service worker caches `/v1/` responses without an actor/client cache identity and returns an invented HTTP 200 empty response when neither network nor cache is available. Its application update/offline behavior needs actual multi-user/session tests. The import path inserts supplied `svgContent` through `dangerouslySetInnerHTML`; browser execution was confirmed above.

### E. QA, knowledge and model truth — critical before automation

`packages/qa/src/engine.ts` fails to aggregate missing-logo findings; checks only existing pages rather than required completeness; does not inspect files in `validatePackage`; and cannot infer actual text/glyph/layout fidelity from missing geometry/renders. Some contrast/safe-zone checks are advisory regardless of a desired strict release policy.

`retrieval-service.ts` filters only client/active initially, lacks tenant identity in stored items, does not restrict authoritative rules/assets/templates to approved/project-compatible items, and invents vector/rerank scores. Ingestion parses sample text rather than real file bytes.

`model-gateway.ts` contains real provider HTTP branches, but catches failures into canned outputs, can return a passing vision judgement without an image/provider, rewrites some model IDs while reporting another, and reports fixed token counts. Provenance now labels deterministic fallback, which is useful, but **a provenance label does not justify a false passing judgement**. Budgets/egress/deadlines/schema policy require enforced tests.

`packages/evals/src/runner.ts` still uses `FakeModelGateway` for the routing/brief tournament. Retrieval evaluation populates examples from expected relevant IDs and query text, so high scores do not establish real-world retrieval quality. Such tests may test plumbing; they are not independent held-out model/retrieval admission.

### F. Deployment, CI and restore evidence — unproven or misleading

The repository contains competing deployment descriptions: the master-selected Node 24/PostgreSQL 18/Caddy path versus the infra Node/PostgreSQL 17/nginx path and mutable tags/default credentials. `deployment/Dockerfile.hawa` expects root `dist/server.mjs`, `migrate.mjs` and `healthcheck.mjs`; actual build output must be proven compatible. No clean deployment was run here.

CI configuration is under `infra/ci/`, not an observed `.github/workflows/` directory. `run_ci.sh` prints fixed pass totals and “all 19 gates verified” after checks that do not execute all eight normative acceptance gates. The secret scanner is regex-based; root lint does not validate the referenced project graph.

`infra/backup/backup_restore_drill.sh` concatenates schema/RLS/seed as a “snapshot” and runs simulated restoration tests. It cannot establish recovery of actual work. The separate guarded `deployment/restore-test.sh` is more honest: it ends awaiting application verification. Build on that real restore path and complete it; do not discard useful foundations.

## What is worth keeping

- Clear master invariants, 105 requirements, traceability and existing acceptance/fault/editor-proof plans.
- Separation into domain/contracts/adapters, useful exact-copy and state-machine helpers, and fast deterministic tests.
- Interactive layers, inspector, local editing, source-export direction, draft/history and ZIP work as implementation foundations.
- Guarded deployment/restore scripts and explicit architectural admission decisions as starting points.

The recommendation is not a wholesale rewrite. First close trust/data/security boundaries, then prove one canonical editor/render/source workflow, then enable real connected integrations. Use the current app as a prototype and diagnostic sandbox until its relevant release gate passes.

## Evidence files and reproducibility

| File | Purpose |
|---|---|
| `TASK_SHEET.md` | Full 42-package completion contract and release gates |
| `tasks.csv` | Machine-readable task summary, dependencies and OPEN status |
| `requirements-coverage.csv` | All 105 FR/NFR planning mappings |
| `probes.ts` / `probes.json` | Isolated source reproducers and actual observations |
| `browser-check.cjs` / `browser.json` | Read-only responsive browser inspection |
| `browser-import-probe.cjs` / `.json` | Harmless imported-markup execution reproducer |
| `checks.json` / `logs/` | Initial diagnostic run, including failures/blocked prerequisites |
| `final-checks.json` / `final-logs/` | Later build/dependency recheck during concurrent edits |
| `source-before.json`, `source-after.json`, `source-final.json` | Git/environment context and source fingerprints |
| `evidence-sha256.json` | Digests of this audit's generated artifacts |

Source probes run with `pnpm exec tsx output/audits/2026-09-05-reliability/probes.ts` from the project. They block external fetch and use synthetic in-process app instances. Exit zero means the **audit executed**, not that violations are absent; inspect `violations` and `executionErrors`. Browser scripts require Playwright/Chrome and the separate local development origin noted in the script. Run future destructive/security/provider tests only in authorized disposable environments.

This audit package is a point-in-time assessment, not a release certificate. Keep the original evidence when later fixes arrive, and add linked regression receipts instead of rewriting past results.
