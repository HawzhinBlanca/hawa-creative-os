# KAAE 2025 integration review — 2 October 2026

Requirements: FR-017, FR-023, FR-038. Preserve MASTER_SPEC invariants2,5,7,8 and the owner-directed content-aware/photo-selection rule. Source: docs/05_CREATIVE_ENGINE.md; ADR238 in Claude's unfinished worktree.

## Confirmed parser boundary issue

Read-only source probe of `.claude/worktrees/kaae-2025/packages/creative/src/studio/page-grammar.ts` (`pageGrammarFromRaw`, line102; downstream `middleStop`/`headerPrimitives`) freezes SHA256 `803c38d3e5c5f8a0948eedda7a32ceebe729b64c2d5b39d47e1f5296d7624155`. The parser walks colors and requires only top-level members, then asserts PageGrammar without validating nested structure or numeric values.

| Input | Parser | Downstream result |
| --- | --- | --- |
| Required top-level members present as empty objects | Accepted | TypeError |
| Header accent gradient has zero stops | Accepted | TypeError |
| Header accent widthShare is a nonnumeric string | Accepted | Nonfinite native shape geometry |

Receipt: `output/qualification/2026-10-02/native-acceptance/GRAMMAR_REVIEW.json`; reproduction: `/private/tmp/hawa-grammar-review.mjs`. Source hash is checked before/after the probe. No Claude files were edited, no provider call or deployment performed. These failures apply to that unfinished snapshot, not current production or the published research branch.

## Required repair at integration

Validate the complete optional grammar at its reference admission boundary, before composition or paid model work: required nested objects; actual string/font/color types and palette membership; finite, bounded dimensions/shares/opacity; nonempty bounded ordered gradient stops with valid endpoints; bounded ornament counts and permitted enums. Missing grammar remains optional; supplied invalid grammar returns a structured refusal with the failing field. Do not hide a malformed supplied grammar by silently omitting it.

Add direct refusal controls for the three reproduced inputs, plus a valid grammar and absent-grammar compatibility. Keep whole pipeline source/coverage/photo-intent, exact-copy, logo and native transfer assertions during the eventual merge; no global KAAE style should be imposed on other clients.

## Release work still required

The branch reference remainsbaffce10; its new guideline source is uncommitted. Re-read the completed commit and ADR238 evidence before integrating. Desk brand-face/showcase handoffs and the active DNA row/Canva brand kit remain separate items in Claude's `plans/kaae-2025-guideline/INVENTORY.md`. Do not assert the kit or source fonts are admitted from the palette update. Actual current Canva edit/save/reopen, native-language/human quality and production admission remain open.

## Connected admission repair — ADR239, 2 October 2026

The research branch now validates optional grammar at the actual packaged-client
resolver and shared studio reference reader. Three original loader failures and two
compatibility passes are retained. Final eight connected files:126 passed/0 failed/0
skipped;725 strict test roots, production build and lint pass. A stale compiled-export
intermediate failure was repaired by rebuilding, not by relaxing assertions. Gradient
and palette table arguments were corrected to exercise complete input arrays.

The pure fixed-depth schema validates nested structure, actual finite numeric types,
palette membership, bounded native gradients, ornaments and explicit metadata. Invalid
supplied grammar has a structured field refusal before logo/model/composition work;
absent grammar keeps existing behavior. Reference identity and casing are preserved.
A stable read-only snapshot of Claude's actual newer reference passes this admission.

The unfinished Claude parser itself has not been changed or merged: replace its parser
with the admitted typed result when integrating the completed ADR238 source. This is
focused source qualification; no full release, paid model, font/glyph/native/human or
production admission. Evidence: W5_PAGE_GRAMMAR_ADMISSION_PROOF.json.


## Completed ADR238 source integration — 2 October 2026

Claude finalized clean4c95154a during the ADR239 repair. Integrated it with8ca1fa4a,
consolidated the parser onto typed admission and preserved source/photo/continuous
background/strict native-font and QA authority. Client grammar now reaches editorial
and storyboard compositions. A guideline alternative cannot replace multiple-photo
or cutout intent; owner-directed one/several and explicit-only coverage replace the
reference's hero-only wording. Desk handoffs complete; official logo untouched.

Final18files299/0/0,725 strict roots/build/Desk build/lint PASS. Original264/4 and
intermediate failures retained. Two current-client multi-photo layouts pass measured
render QA and actual editable-copy/font/source-byte checks. An independent raster
control verifies the gradient contrast enclosure. Local measured logo scrims must
remain inside clear space; blanket light-overlay assertion replaced with that bound.
Full source gate pending; no production/DNA/Canva-kit/native-save/human admission.
See KAAE2025_INTEGRATED_PROOF.json for exact sources and receipts.


### Initial full gate and current-guideline fixture repair — 2 October 2026

Clean264a7af5 full suite:7610 passed/1 failed/67 skipped,717 passing files/1 failed/6 skipped. H11 expected a right-aligned seal rule to activate in KAAE, but current compound page grammar causes the real moderation route to return409 CONFLICTING_RULES_PENDING. Original full and direct diagnostic failures retained. Production conflict logic is unchanged. The corrected matrix preserves that current-client pending refusal and unchanged activated rules; its other-client control still activates the compatible initial rule through the real200 route and refuses the subsequent contradictory rule through direct miner and409 API. Three connected files/21 tests pass. This repairs a stale fixture, not a comprehensive semantic conflict engine. Full source retry pending; production/native/human/DNA/Canva-kit admission remain open. See KAAE2025_INTEGRATED_PROOF.json.
