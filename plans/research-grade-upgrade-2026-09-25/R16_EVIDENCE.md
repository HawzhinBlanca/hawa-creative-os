# R16 — Final Canva export preflight, first two slices

**Date:** 2026-09-25. **Status:** in progress. **Latest source:** `4add30c` on `codex/research-grade-design-system`. The first slice source `f8f90fd` had evidence `1a781fc` and seal `7f4639e`.

## Reproduced failure and repair

The QC evaluator accepted a stored `content_check` with `copyPass: true` and `fontPass: true` without inspecting the export bytes. A checked deck could be replaced with one containing different copy and a new matching SHA-256, yet the old receipt still approved it. It also accepted a receipt without export bytes or with an inconsistent stored hash. Both new negative tests failed against the earlier evaluator and passed after the repair.

The evaluator now requires a nonempty PPTX, a matching stored SHA-256, and expected source copy. It opens the actual deck, compares its text against that copy, and checks its fonts and direction using the captured policy. An explicitly failed capture check cannot be overridden by a later read. The Canva capture path records the expected source copy with its check so a later Desk recapture can be evaluated even when no design-plan row exists. When a current plan or approved copy is supplied, that copy takes priority. The test fixtures for approval, delivery and publish paths now contain real editable PPTX files instead of arbitrary strings labeled as decks with fabricated passing receipts.

**Verification:** the two negative cases were red before the fix. The first full suite after the stricter check failed 35 tests across 13 files, exposing fabricated historical fixtures. After replacing those fixtures, the focused checks passed and the full suite passed **406 files / 3,064 tests**, with **4 files / 48 tests skipped**. The source and included tests passed TypeScript. Blueprint validation passed **737 checks / 0 warnings / 0 failures** and the clean source-candidate release manifest verified. The corrupt-copy end-to-end case now uses a real PPTX with changed text and produces a failed QC run. No live Canva account or human visual assessment was used.

## Second slice: unknown RTL evidence routes to a reviewer

A Canva PPTX can omit readable RTL direction metadata. The prior evaluator reported `bidiIsolation: true` in this case, even though the check itself said visual review was needed. Source `4add30c` reports `bidiIsolation: null` and `rtlVisualReviewRequired: true` for that condition. The Desk shows it as pending and asks the art director to inspect a selected final PNG. The approval route requires the reviewer to confirm against the checked PPTX hash, requires a selected PNG, and stores the signed-in reviewer, QC run, export hash and confirmation time in the durable decision payload. The Desk no longer sends a canned assertion that brand, hierarchy and exact copy were verified.

The evaluator test proves the unknown state for a Canva-style Sorani deck without an RTL flag. A database-backed decision test supplies that reported unknown state: no attestation, a wrong hash and no selected PNG each return 412; the correctly bound review returns 201 and persists attribution. This route test injects the QC report to isolate the approval boundary; it does not pretend to be a live Canva export. Focused checks passed **2 files / 19 tests**. The fixed-tree full suite passed **406 files / 3,065 tests** with **4 files / 48 tests skipped**; TypeScript passed.

## Admission limits

R16 is **not accepted**. These slices verify one semantic source format and require accountable human review when Canva omits RTL metadata. The app does not automatically inspect a final PNG for blank, clipped or overlapping content; compare layout geometry, logo pixels or protected assets; measure Sorani glyph appearance in rendered output; or prove the PPTX and PNG represent the same Canva design version. A reviewer's check is an attestation, not an independent automated measurement or native-speaker study. The captured font policy and fallback source copy are retained in the export receipt; independent immutable source-policy binding remains to be implemented. There is no seeded defect suite, frozen clean-export holdout, measured false-block rate, real live export or native-speaker sign-off. Approval and production qualification therefore remain open.

**Release status:** the first slice was sealed and verified. The second source candidate awaits its manifest seal. Neither is a built or deployed image; no production rollout or feature-flag enablement occurred.
