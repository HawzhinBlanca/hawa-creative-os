# ADR-028: Bounded Sorani Kurdish copy in automatic Canva drafts

**Date:** 2026-09-14
**Status:** Accepted (provisional typeface; brand font confirmation pending)

## Context

The office's main client (KAAE, default language `ckb`) writes in Sorani Kurdish, and PRD FR-034
requires Sorani support, yet the automatic Canva draft path refused any Arabic-script character with
`COPY_UNSUPPORTED`, so every Kurdish request went to manual design. Two facts shaped the fix: the
mandated brand typeface (Minion Variable Concept) carries no Arabic glyphs, and the reference pack
extracted from the client's brand guideline records no Kurdish typeface at all. Inventing a brand
font silently would be dishonest; refusing all Kurdish work forever is unacceptable for a Kurdish office.

## Decision

- The reference pack gains `rules.scriptFonts.arabic` (currently `Noto Sans Arabic`) together with
  `scriptFontNote`, which states in the pack itself that the typeface is provisional for drafts and
  that the art director confirms the brand's Kurdish font before release. The note travels with every
  plan's evidence manifest (`rtlFont`, `rtlFontProvisional: true`, `rtlBlocks`).
- The planner classifies every copy block: Latin, Arabic script, or unsupported (any other script,
  symbols outside common punctuation, emoji). Unsupported copy is refused with `COPY_UNSUPPORTED`
  before any paid model call; Arabic-script copy without a script typeface in the pack is refused with
  the same code and a specific message.
- Direction and font are server decisions, never the model's. The model is told which blocks are
  Sorani and asked for wider boxes; after validation the server sets `fontFamily` to the script
  typeface, `align` to right and `rtl` to true on those blocks. The PPTX encoder writes `rtl="1"`,
  right alignment, `lang="ku"` and the complex-script typeface, and admits extra fonts only when the
  pack declares them.
- QA judges each exported text object by its script: Latin objects must carry the brand font, Arabic
  objects the script typeface; `rtlPass` records whether Canva preserved the right-to-left paragraph
  flag. Nothing here certifies glyph shaping or layout; that remains the visual review the manifest
  already demands (`nativeVerification: required`).

## Consequences

- Kurdish requests now produce an editable Canva draft attributed honestly as provisional in font.
  The requester's message for refused copy names the real reason (other scripts or symbols).
- When the client's Kurdish typeface is known, change one field in the reference pack and remove the
  provisional note; no code changes.
- Rollback: remove `scriptFonts` from the pack and every Kurdish request is refused again, exactly as
  before, with the honest message.

## Verification

- `packages/creative/test/editable-transfer-rtl.test.ts`: slide XML of a Kurdish run.
- `packages/qa/test/canva-pptx-check.test.ts`: per-script font pass and RTL evidence.
- `apps/core/test/canva-design-planner.test.ts` (real PostgreSQL): manifest fields, server-enforced
  direction and font, refusal of an unsupported script before any call.
- Live round trip on the office stack: see INDEPENDENT_REVIEW.md section 16.
