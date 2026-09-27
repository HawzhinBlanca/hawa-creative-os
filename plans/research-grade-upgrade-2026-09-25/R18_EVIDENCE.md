# R18 — Review evidence missing-state containment

**Date:** 2026-09-25. **Status:** in progress. R17 exact-export approval binding is not complete.

The review-desk route previously invented a Canva design ID and edit URL, a captured PNG and hash, and a logo hash, palette and font list whenever task evidence was absent. These looked credible to a reviewer and made the response unusable as an evidence record. It now reports `canvaStatus: not_configured` with null ID/URL, `captureStatus: not_captured` with no files and null hash, and `brandReferences.status: not_configured` with null logo hash and empty color/font arrays. A bound Canva ID is read from PostgreSQL and labelled `recorded`, not verified. An exact-revision capture row with a valid hash and nonempty artifacts is labelled `recorded_metadata_only`, with its artifact count and hash but no invented preview or export ID. The task client ID remains as scope, without implying approved brand rules.

The prior test that asserted the fake Canva link and PNG was corrected to require the missing states and absence of the placeholders. A new test stores a real bound Canva design and a valid capture row in PostgreSQL: before capture, the response shows the design ID without a fabricated file; afterward, it shows exact-revision capture metadata without a fabricated preview. Three focused Core files passed **27 tests**; package and script TypeScript checks passed. The fixed-tree full suite passed **406 files / 3,031 tests**, with 4 files / 48 tests skipped. No model, Canva or production configuration was changed.

This is a read-path correction. The response does not yet load a revision-bound approved BrandKit, verify that a recorded Canva ID is live, or prove capture bytes against a final export. R17 now requires an explicit byte-verified export selection before approval, but exact-revision capture/QC linkage and post-edit invalidation remain open. R18 remains open until those and the independent approval refusal tests pass.

**Second pass — review record fields:** A stored QA run previously made `glyphCoveragePass: true` and `unobservedLayersCount: 0` in the review response even when its report measured neither. The response now uses explicit valid values from the stored report and returns null otherwise; a red-before/green-after PostgreSQL test covers both fields. A Canva-bound task with no design revision previously displayed `revisionId: "rev-1"`; it now returns null and rejects a malformed requested ID (422) or a valid ID not belonging to the task (404). The edit link now comes from the stored Canva binding if it is a valid `https://www.canva.com` design URL; Core no longer manufactures a link with a hardcoded Desk return URL. Focused Core tests passed after the changes. The fixed-tree full suite passed **406 files / 3,038 tests**, with 4 files / 48 tests skipped, and TypeScript checks passed. The release-manifest check for this second pass is pending.

The second-pass source commit `f564358` was sealed in `6dae437`; the release-manifest verifier passed, and package validation reported **725 pass / 0 warning / 0 failure**. No deployed image or live Canva account was exercised by these checks.

R18 remains **in progress**. A recorded binding is not a live Canva verification, a capture-set row is still metadata only, and the response does not yet associate the R17 checked export with a reviewable capture or a revision-bound BrandKit. The earlier 2026-09-25 paragraph is retained as the first-pass observation; its statement that exact QC linkage was absent is historical after the R17 fourth pass.

## Third pass — no invented QA run for a human decision

**Source:** `ccc6213`, inventory follow-up `263ee33` (2026-09-25), ADR-041 and migration 025. `RevisionRepository.recordApproval` used to insert a failed `qc_runs` row with an empty report when a reviewer requested changes before QA ran. That row existed solely to fill non-null columns on the review request and approval. It represented “not run” as “run and failed.” The migration allows a null QA reference for a non-approval decision and adds a database check that an approved decision must name a QA run. The repository still requires the latest real QA run to pass critical checks before approval. Historical rows are retained because the migration cannot establish which older failed runs were artificial.

The direct isolated-PostgreSQL test now creates a revision with no QA, requests a change, and proves null QA references and zero QA runs; a direct approved insert with null QA fails the new database constraint. The Canva lifecycle test establishes a separate case: its draft bridge really does store a failed check, and the office decision points to that check without creating another. The focused group passed **3 files / 15 tests**; migration inventory tests passed **2 files / 11 tests**. The fixed source suite, excluding only the unsealed release-manifest gate, passed **418 files / 3,121 tests**, with **4 files / 48 tests skipped**. TypeScript, lint and blueprint **749/0/0** passed. An initial full run had three failures: two migration inventories fixed in `263ee33` and the expected unsealed manifest gate. The exact sealed-tree run is recorded after the release seal.

This establishes honest QA provenance for this decision path, not full review truth. Canva export/capture binding, live design state, independent visual evidence, migration rehearsal on a restored production-shaped database and deployed approval remain open. R18 and R08 remain **in progress**.

**Migration rehearsal:** Source `9c59f85` (2026-09-25) adds an isolated PostgreSQL test that reinstates the old non-null QA columns and drops the new guard inside a rollback-only transaction, applies the checked-in migration 025 body, then verifies both columns are nullable and the approved-row guard exists. The focused file passed **1 test**; test TypeScript and blueprint **749/0/0** passed. This is an old-shape schema rehearsal with test fixtures, not a restored production-data migration or a runtime deploy. Full sealed-tree verification follows the updated evidence seal.

## 2026-09-27 — font-family checks do not certify rendered glyphs

FR-038/041, NFR-020; this enforces ADR-077's existing measurement boundary.
Real multilingual Canva exports showed one declared PPTX family but additional
PDF font resources. Core nevertheless mapped family membership to `fontCoverage`,
and Desk claimed all glyphs were covered by named OFL fonts with zero tofu.
Core now records `fontFamilyPass` separately and `fontCoverage: null`; Desk shows
declared families and unverified rendered glyphs with separate statuses. Missing
or unreadable bytes do not invent a measured font-family result. Existing copy,
font-family refusal, RTL visual review and human approval controls remain intact.

Historical QC reports and hashes are preserved. Task reads extract explicit
family evidence from the named legacy check; the old coverage flag alone proves
nothing. The compact list query now includes that evidence and the previously
dropped `rtlVisualReviewRequired` flag. Regression tests cover historical true,
false and absent measurements, immutable stored hashes, list/detail agreement,
the real Canva PPTX and rendered Desk states.

Red-before: **12 failed / 52 passed**. Final focused run after the DB package
rebuild: **9 files / 122 passed**, no skips. TypeScript (including tests), lint and
Desk build pass. Earlier post-fix failures identified the SQL projection and a
run against stale compiled DB output; both are retained in the execution account.
Full app regression and deployed-image checks were not rerun. See
`R19_MULTILINGUAL_PROOF.json`; R18/R19 and release admission remain in progress.


## 2026-09-27 — native locale/style capture and paragraph direction truth (ADR-082)

Capture source `aefeabc`: two real imports and six exports preserve fourteen exact
PPTX strings, Studio line breaks and per-character text colors across three declared
font families. The ten-string sheet has zero changed decoded pixels out of 2.4M
against its older capture. Canva rewrites locales to ar-EG/en-US, so source language
provenance must remain in Hawa. The read-only content tool concatenates paragraph
breaks and supplies no native element IDs/style spans; it is not an exact source map.

Actual `rtl="true"` paragraph attributes exposed the old parser's false absent-metadata
claim. New checks read both XML boolean spellings, inspect each paragraph, preserve
explicit source directions in the frozen export policy, and separate metadata from
rendered bidi. Mixed text is not automatically RTL. Core no longer waives explicit
false/invalid flags when no true flags remain. Every eligible Arabic/Sorani export
requires the existing hash-bound visual assertion, even with correct metadata. Desk
and Client DNA copy now describe that boundary without promising rendered isolation.

The real-file approval test exposed another production bug: canonical task-copy
objects were passed to a string-only evaluator. Both saved shapes are now read
exactly; wrong/malformed task copy cannot be replaced by a passing capture receipt.
The isolated gate rejects no assertion, wrong hash and absent selected PNG, then
accepts the correct synthetic reviewer assertion. This is not a real human approval.

Red: 10 failed/16 passed. Final connected group: **8 files/128 passed, zero skips**.
Project/script/test TypeScript, lint and Desk build pass. Intermediate native-gate
failures are retained. Full regression and deployed-image qualification were not rerun.

A retained negative control remains open: Studio's Arabic-font fallback overrides
explicit rtl:false before import. Current QA detects it against requested direction.
Next repair: respect explicit direction in the transfer and verify the real round trip.
Human typography review, committed native edit/save/reopen, broad office corpus and
full live workflow remain open. No production deployment/migration, model call or
message occurred. See `R19_LOCALE_CANVA_PROOF.json`; full admission remains false.


### Refreshed candidate and full regression qualification

Implementation `34eac23`, sealed candidate `8dd04cc`: the refreshed isolated app
passes all 36 workflow invariants, with real offline Docling and synthetic external
providers/identities. Core/Desk/worker image labels match the candidate, runtime
source changes are empty, and four list/detail QA reads agree. Compiled Core/QA
evaluate two retained real Canva files: corrected direction requires visual review,
old explicit direction conflict fails, and altered canonical task copy fails both.
Compiled Studio respects all six requested directions. No provider/model call
is needed for these compiled checks. The first probe used the wrong report-field
name; that probe error was corrected without changing runtime code.

First full regression: 3,685 passed/2 failed/59 skipped. Both failures were old
backup expectations superseded by ADR-081. Updated tests require corrupt/locked
packs to fail before restore with unknown store counts, and incomplete cloud
transport to fail before a dump/upload/collection. Isolated backup follow-up 6/6
passed; final full regression **3,687 passed, zero failed,
59 skipped** across 464 files. Test types pass. Runtime is unchanged
from candidate 8dd04cc; the final full run includes the uncommitted test-only correction.
Earlier failed test receipts remain in the proof.

This is engineering evidence for the isolated candidate. Production, actual human
review, native edit/save/reopen, mixed-token isolation and live delivery remain
unqualified; Workspace reviewer configuration, off-host/independent recovery and
held-out creative quality/cost gates remain open. See R19_EXPLICIT_DIRECTION_PROOF.json.
