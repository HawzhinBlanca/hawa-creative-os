# R11 — Scoped brand inputs in the Canva planner

**Date:** 2026-09-25. **Status:** in progress. This is a client-general planner slice, not acceptance of the three-client BrandKit/DesignIntent exit criterion.

The Canva planner previously used a packaged KAAE reference for KAAE tasks and refused other clients. Its system prompt and palette correction also contained KAAE-specific colors and style language. A red-before Sorani test exposed the hardcoded palette names. The planner now builds the system prompt and all fallback colors from the task's resolved reference. Font family names are bounded before insertion into the system prompt. An unknown client with no active reference fails before a paid model or Canva call.

For a second client, Core reads the active version of `hawa.client_dna_versions` under tenant/client RLS, checks the DNA identity and content hash, compiles palette roles and Latin/Sorani fonts, and reads the primary PNG logo by its recorded SHA-256 from the content-addressed store. The logo asset ID and hash, DNA version/hash, palette, fonts and logo size/clear-space rules travel in the saved plan manifest. The server corrects model colors to that client's palette, applies body font rules, and enforces the selected logo's minimum width and clear space before making an editable source. A mocked model and Canva integration test generated a second-client draft using its own colors and logo without KAAE data in the model request. A brand-version change before the model response is processed leaves a failed plan with its model receipt and no Canva import; a stale saved plan cannot start a fresh import. An already-claimed remote import remains reconcilable after a later brand change.

The packaged KAAE reference remains a transitional client-specific input. The Design Studio v3 path still has KAAE assumptions. This slice does not establish signed client approval of DNA or assets: active Desk DNA records can have `approved_by = NULL`. It also does not prove ownership of a blob hash by one client, approved exemplars for other clients, three unlike-client cases, visual quality, or edit/export recovery. The active version is checked before import, but a version change in the short interval between the final check and the external Canva call remains a concurrency risk. R11 stays open.

**Verification:** Source commit `3b5bc8a`, sealed manifest commit `15d0550`. The focused planner file passed **24 tests**. The fixed-tree full suite passed **406 files / 3,045 tests**, with 4 files / 48 tests skipped; `pnpm typecheck` passed, blueprint validation reported **729 pass / 0 warning / 0 failure**, and release-manifest verification passed. An earlier whole-suite run on the unsealed worktree had 3,043 passing tests and the expected release-manifest failure; it is not counted as a green gate. No production flag, deployment or human quality study was changed.

## 2026-09-25: standard Studio second-client boundary

The standard Studio path now resolves the task's own active versioned Client DNA and hash-checked logo instead of loading KAAE's packaged pack for every run. The saved request binds client ID, reference hash, DNA version and logo hash. Each resumed stage re-resolves that exact historical version and checks the saved hashes; a generation stage also requires it to remain the active version. This separates recovery of a previously transferred run from permission to make a new design after brand changes. The qualified KAAE v3 path remains KAAE-specific. A second client entering that route receives `CLIENT_V3_PROFILE_REQUIRED` before a model call until a client-specific font and exemplar profile is admitted.

Client DNA logo minimum width and clear space now reach the standard Studio layout prompt, validation, revision, and hard QA. The validator enforces the stronger of house and client minima. A negative test uses a layout that passes house rules but fails the stricter client's width and clearance. A second-client integration test records its own palette, fonts, logo and version; it confirms no KAAE name or gold palette in the brief request, no model call on the v3 refusal, a stable historical reference hash after supersession, and refusal of further generation when the active reference is gone. **Focused verification:** 2 files / 33 tests passed; TypeScript source and included tests typechecked. The prompt version is `2026-09-25.1`.

This does **not** qualify R11. The second-client test reaches the brief stage, not a completed editable Studio export. The packaged renderer still has a KAAE logo fallback if called without an explicit logo, v3 prompt/renderer and exemplars remain KAAE-specific, and client approvals plus three unlike-client trials are absent. The house motif vocabulary may also be unsuitable for some brands. No visual quality, Canva round trip, or production behavior is inferred from the focused tests.

The first sealed-candidate whole-suite run failed **3 files / 5 tests** and reported 4 unhandled rejections (403 files / 3,042 tests passed). All five failures came from older Studio tests that constructed a run without the now-required saved reference/client/logo hashes or called the now-asynchronous stage-context builder synchronously. Those fixtures were updated to resolve the packaged reference and await context creation. The affected set then passed **5 files / 44 tests**, and TypeScript checks passed. This red run is retained as evidence, not described as a green gate.

**Fixed-tree recheck:** Source `1d93807` sealed by `c42dc3f` passed the full suite: **406 files / 3,047 tests**, with **4 files / 48 tests skipped**. TypeScript checks passed, package validation reported **729 pass / 0 warning / 0 failure**, and the source-candidate release manifest verified. The production flags remain `DESIGN_PIPELINE_V3=off` and `DESIGN_STUDIO_V2=off`. No deployment, live Canva round trip, client approval, or blinded human rating was performed. The later evidence-only commit does not change the exercised source.

## 2026-09-25: mocked Studio transfer and exact client font admission

Source `15b6d9b` extends the second-client Studio fixture from brief through concepts, layouts, rendered candidates and a transferred PPTX source passed to a **mocked** Canva importer. The test compares the source hash, exact two-block copy and Inter font in the generated PPTX; its manifest binds the client's logo SHA-256. It checks every recorded model request for absence of KAAE and its gold hex, the generated layouts for the second client's palette and logo minimum width, and the lack of further model calls after DNA supersession. This is an isolated pipeline contract test, not a real Canva round trip, export, or visual design judgment. The PPTX check itself reports logo verification as `not_qualified`; the manifest hash alone does not prove visible logo fidelity.

For active client DNA, a Studio run now admits only display fonts from that client's versioned reference and requires each body/display family to have a **measured exact renderer verdict** and glyph coverage for the required copy. An unavailable family fails before a run, model request or Canva import. Layout and hard-QA validation refuse an otherwise globally known font outside that client's set; Arabic-script client layouts no longer silently substitute a different face. The admitted set and logo constraints now reach layout, revision and directed-edit requests and validators. The packaged KAAE path retains its transitional font rules. The Studio layout prompt version is `2026-09-25.2`.

The admission uses the renderer's per-script `probeFontScripts(...).verdict === 'exact'` result. Its older convenience `probeFontFidelity` maps an unmeasured/uncovered verdict to `exact`, so using that convenience method at a paid generation boundary would admit a font whose fidelity was never measured. Unknown or failed probes therefore refuse this client's run. ^[inferred]

The focused Studio/validator set passed **3 files / 49 tests**, and source plus included-test TypeScript checks passed. A deliberately malformed test intake first failed with `COPY_REQUIRED`; fixing that fixture made the negative font test exercise the intended `CLIENT_FONT_UNAVAILABLE` path. That red run is not counted as acceptance. R11 remains **in progress**: no client-signed DNA or asset approval, three unlike-client cases, independent blob ownership, real Canva import/export, or blinded human design rating has been supplied. House motifs and v3 remain client-specific risks.

The first whole-suite run on source `15b6d9b` was **not a passing gate**: 405 files / 3,048 tests passed, 4 files / 48 tests skipped, and one release-manifest test failed because `RELEASE_MANIFEST.json` still identified the previous source. No functional test failed in that run. A refreshed package, release seal and fixed-tree recheck followed.

**Fixed-tree recheck:** Source `15b6d9b`, evidence commit `7cedba3` and manifest seal `0294693` passed the complete suite: **406 files / 3,049 tests**, with **4 files / 48 tests skipped**. TypeScript checks passed, blueprint validation was **729 pass / 0 warning / 0 failure**, and the clean-tree source-candidate release manifest verified. The production flags remained off. This is source verification only; no deployed image, real Canva export or client quality admission was tested. The subsequent evidence-only update does not change the exercised source.

## 2026-09-25: explicit logo at the Studio renderer boundary

The generic Studio renderer no longer supplies a packaged KAAE image when a logo-bearing layout has no client logo. It requires explicit decodable image bytes or an existing image file and refuses missing, unavailable, or invalid input. Core now passes the task's resolved logo to v3 refinement critique and judge fallback/canary renders; the art composite accepts the same explicit render options. The art generator also validates the logo before calling its paid image provider. Older KAAE tests now supply their own KAAE fixture. ADR-047 records the fail-closed decision.

A red-before renderer test caught the old fallback. A supplied second-client test image renders different pixels from the KAAE fixture. A separate red-before test proved the art generator would spend a provider call before reporting a missing logo; the repaired path makes zero such calls. The first wide source run exposed **38 failing tests in 10 Core files**: their old synthetic contexts omitted the logo and therefore could no longer render or complete revisions. The contexts were corrected to provide the exact KAAE test asset. That failing run is retained as diagnostic evidence and is not an acceptance result. The corrected affected Core set passed **10 files / 115 tests**, and the creative package passed **70 files / 634 tests** with one skipped file/test before the added art preflight test. TypeScript and lint passed. Whole-suite, pack, and release-seal results are recorded below after completion.

**Final source checks for this slice:** 420 files / **3,193 passed**, 4 files / 48 skipped; `pnpm typecheck` and `pnpm lint` passed. The secret scan found zero committable secrets. Blueprint validation reported **765 pass / 0 warning / 0 failure** before the final evidence refresh. The release-manifest check is performed on the clean sealed commit, because the manifest binds the source commit and cannot pass on this edited tree.

This closes the implicit packaged-logo path in `render-layout-v2.ts`; it does not qualify full R11. The v3 generator's prompts, font choices and exemplar profile remain KAAE-specific; client-signed asset/DNA approval, three unlike-client creative trials, independent blob ownership, real Canva import/export, and human quality evidence remain open. The test proves a local rendering boundary, not visual correctness of an external export.

## 2026-09-25: layout-derived art direction in the generic art helper

The generic conditioned-art helper still appended “academic” and “deep dark navy” to another client's explicit botanical concept, and its provider-failure motif used fixed KAAE-like navy/gold colors. A red-before second-client test caught the prompt contamination. The repaired prompt uses the layout's declared concept, canvas shape and bounded layout colors; its reserved text zone asks for low visual detail without forcing a dark palette or architectural motif. The procedural fallback uses those same layout colors. Two unlike synthetic layouts now produce distinct fallback art rather than the same house-color image. The creative package passed **70 files / 636 tests** with one file/test skipped; TypeScript and lint passed.

The source suite excluding the release-manifest test passed **420 files / 3,194 tests**, with **4 files / 48 tests skipped**. The secret scan found zero committable secrets. The release-manifest test is run after source sealing. This helper is not the Core v3 art provider, so this result does not generalize the v3 generator, its exemplar retrieval, font selection or its other prompt paths. R11 and the three-client exit condition remain open. The two layouts and provider response are synthetic; no live image model, Canva export or human assessment was performed.

## 2026-09-25: procedural motif palette boundary

The shared motif utility still replaced an empty palette with seven packaged KAAE colors, so a missing client palette could make a valid-looking wrong-brand fallback in the Core art stage. A red-before test confirmed that `generateMotifSvg` accepted `[]`. The production image-provider prompt also substituted house colors for an empty palette, allowed a paid attempt before failure, and forced “photographic or painterly,” soft neutrals and a dark calm region on unrelated client art. Two red-before provider controls caught that. The utility now refuses empty palettes and non-hex colors before SVG generation, and gradient/diagonal helpers no longer carry their own KAAE color defaults. The production provider validates its palette while composing the prompt, before any external image request, and its suffix preserves the supplied art direction and palette without imposing a dark style. Focused motif/provider/art tests passed **3 files / 41 tests**. The first overlapping full run began before the provider repair and captured the two expected red tests (419 files/3,195 tests passed, 1 file/2 tests failed, 4 files/48 skipped); it is not acceptance evidence. The corrected source suite passed **420 files / 3,197 tests**, with **4 files / 48 tests skipped**. TypeScript, lint and the zero-secret scan passed. This guards a local boundary; it does not prove the supplied palette was approved or that final Canva art is faithful.

## 2026-09-26: registered-client Desk intake and isolated brand editors (ADR-066)

**Requirements:** FR-008, FR-011, FR-017, FR-078. The new-request form listed three
packaged clients and preselected KAAE. The DNA screen separately filtered every
other registered client out. Replacing those choices exposed an asynchronous
scope hazard: a delayed response for the previous client could overwrite the
newly selected client's state. The form now reads the authorized directory,
requires an explicit client, preserves an unavailable saved client, reports
failed reads and offers retry. Each DNA editor has a separate lifetime keyed by
client UUID, so old reads, saves and editor controls cannot update the next client.
Remote command search has no guessed default client.

Core's directory joins active clients to their active DNA and uses canonical
row UUID/version rather than an embedded alias. DNA detail likewise returns the
canonical identity. Manual intake rechecks writable active client, active DNA
and same-client active project under transaction locks before creating task,
event and outbox. The original body determines idempotency, independently of
server-derived DNA evidence. A committed retry returns its original task and
metadata after DNA/client changes, including receipts written by the preceding
server. Changed intent conflicts. A first definite refusal permits correction;
an earlier uncertain browser save stays frozen and may be retried even when
its client leaves the directory.

**Verification:** The initial UI file failed **4 tests**, and the PostgreSQL file
failed **3 tests**, before implementation. The first affected group passed
**7 files / 43 tests**; subsequent retry-compatibility and existing Desk checks
passed **4 files / 44 tests**. Adding a read-only identity control exposed a test
fixture mistake (`auth_provider` does not exist on `users`): the broad source
run had **432 files / 3,339 tests pass, 1 file / 1 test fail**, with **4 files /
52 tests skipped**. That failure is not a passing full-suite result. The fixture
now uses the actual user schema and isolated owner provisioning, while the app
still runs as the restricted database role. The corrected final affected group
passed **3 files / 18 tests**, covering a cross-client project, a read-only actor,
legacy/current exact replay, late reads/saves and browser recovery. The exact
sealed-tree suite follows this checkpoint.

**Limits:** These are local PostgreSQL and rendered jsdom fixtures. No new-client
onboarding, live Canva output, three-client creative comparison, Workspace
configuration or deployed operation is qualified. The broader R11 exit condition
and release admission remain open; production design flags stay off.
