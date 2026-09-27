# R19 — Native Canva and reconstruction evidence

## 2026-09-27: first current real-provider qualification

Source `751556f`; requirements FR-028, FR-031 and NFR-010. R19 remains
**in progress**. See `R19_NATIVE_CANVA_PROOF.json` and
`output/acceptance/2026-09-27-native-canva/README.md` for exact artifacts and limits.

Current Hawa OAuth refresh/read and actual PNG/PDF/PPTX export succeeded. Three
exact English text blocks survive export and reimport as independent native text.
Current copy/font QA passes the real export and rejects wrong copy/font controls.
Native reconstruction changes IDs and box geometry by 2–3 px; the decoded PNG
changes 2.2452% of pixels. Therefore this fixture establishes text recovery and
**partial**, rather than lossless, layout reconstruction.

A one-field native draft edit preserved other text and geometry. It was discarded
because the commit tool's required after-preview approval did not arrive.
Committed save/reopen is NOT RUN. Native transactions are closed. The original
design's text is unchanged. This result makes no full Hawa workflow, multilingual,
creative-quality, human approval, delivery or account-loss recovery claim.

All observed effects are retained: two test designs, four export jobs, one import,
normal rotation of the existing Hawa OAuth connection; no model calls, messages,
app restarts or flag changes. Existing full-suite results remain historical; no
runtime app source changed for this qualification.

## 2026-09-27: forty real multilingual strings, partial admission

Capture source `2d4c4de`; FR-034/035/038/041 and NFR-020. Four actual Canva
imports and fifteen exports preserve all forty supplied strings in native text
and final PPTX. Accepted PNGs are 1200×2000. An initial metadata mismatch was
refused and recaptured; a local probe ordering bug resumed the existing import
job. Both failures remain recorded. Native inspection transactions were cancelled.

The PDFs contain NotoSans-Regular alongside NotoSansArabic-Regular, and group 4
has an unnamed Type3 resource, despite passing PPTX family checks. The resulting
false glyph/license QA claim is corrected in Core and Desk; see R18 evidence.
Full multilingual admission remains false: explicit direction, one wide layout,
one family and literal style markers do not establish auto direction, actual
styled runs, multiple fonts, native edit/save/reopen, human language approval or
the required real office corpus. See `R19_MULTILINGUAL_PROOF.json` and
`output/acceptance/2026-09-27-canva-multilingual/README.md`.


## 2026-09-27 — truthful copy language in both import encoders

FR-034/035/036; source correction only, no native Canva qualification. Both encoders
had hard-coded `ku` for RTL while PptxGenJS silently defaulted other copy to `en-US`.
They now validate language tags, bind them by exact-copy index and record `copyLocales`
in the import manifest; unspecified copy is `und`. Plain and accented paragraph runs
carry the same tag. Core uses only explicitly labelled Desk/reviewed-PDF fields with
identical copy/order; old script-derived language labels are not authority. Studio
binds the label to the original text hash and makes revised/legacy copy undetermined.

Red: 12/12 failed as expected. Focused: 8 files/81 passed, then a planner follow-up
with the new explicit Desk persistence case passed 36/36 (82 distinct tests across
the two passing runs). An intermediate suite import failure was fixed without a new
dependency. Creative build, project/script/test TypeScript and lint passed. Full
regression, deployed candidate and real Canva import/export were not rerun.

FR-036's 2026-09-19 blanket qualification is not supported by this active import path.
Language provenance is now explicit, but universal node locale/copy reference and
normalization policy remain unqualified. Existing word-joiner/paragraph formatting
and font-based direction heuristics remain separate work. Source tags do not prove
native Canva metadata retention, rendered language quality or human acceptance.
See `R19_LOCALE_PROOF.json`; production is unchanged, and R19 remains in progress.


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
