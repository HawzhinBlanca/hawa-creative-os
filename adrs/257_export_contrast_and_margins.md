# ADR-257: Contrast and the Safe Area Measured on the Canva Export That Ships

**Date:** 2026-10-02

> Renumbered 2026-10-02: deployed as ADR-256 in production e4057a7a. Codex's branch `codex/hawzhin-app-integration` already uses 256 (`256_hawzhin_workspace_customer_boundary.md`), so this record moved to 257. Code comments say ADR-257.
**Status:** Implemented on branch `claude/hunt4-qa-titles` (from `080bdc8a`); not deployed.
**Requirements:** FR-038 (safe zones), FR-041 (reviewers inspect QA evidence before approval).
**Changes a foundation:** no. No migration, no new dependency, no new paid call. Two optional fields in a QC report (`warnings`, measured `contrastCompliant`/`safeMargins`).
**Builds on:**
- ADR-253 section 2.6: the gap (L22) and the proposed follow-up.
- ADR-157/ADR-170: hard QA's contrast on the Studio render.
- ADR-155 addendum and ADR-180: the office draft alert.

**Number:** 256, assigned by the lead.

## 1. Context

Task f3cb89e8 (live, 2026-10-02) had a QC report with `passed: true` and `contrastCompliant` and `safeMargins` both null. `evaluateCanvaExportQc` reads only the exported PPTX: copy, fonts and paragraph direction. Contrast and the safe area were checked only on the Studio render, before Canva. A Canva-side edit, or Canva's own rendering, could change them after that check, and nothing measured the picture that ships.

The picture that ships is a PNG in `hawa.canva_export_bytes`. Approval pins it with the checked PPTX: same design, same binding version and same saved Canva version (`designUpdatedAt`). The Desk's `previewUrl` (`/v1/tasks/:id/exports/:id/content`) and the office photo alert show it.

## 2. Decision

### 2.1 Where the PNG comes from

Every query that reads a PPTX row for the export QC also reads the PNG with the same design, binding version and `designUpdatedAt` (`PREVIEW_PNG_COLUMNS`, `canva-task-outcome.ts`). This covers `recordCheckedExportQc`, `bridgeCanvaDraftRevision` and the redrive. A manual Desk capture already pairs the two (`recordManualCanvaReview`) and now passes its PNG. With no such PNG, both measures stay null, as before. A PNG whose bytes do not match its hash, or whose shape differs from the slide, is not measured.

### 2.2 How each is measured

- **Text frames.** `readPptxTextLayout` (`@hawa/qa`) gives each text frame's box on the slide. It applies every enclosing group's transform (Canva scales its groups' child space) and takes rotation and flips as axis-aligned bounds. It gives each run's colour from the run, then the frame's list style, then the shape style. A theme colour or a modified colour is reported as unresolved, not guessed. It shares the checker's bounded unzip and safe XML parse.
- **Safe area.** `measureExportText` (`@hawa/creative`) holds each frame's box, in PNG pixels, to hard QA's own safe area: `getSafeZoneBox` and `HOUSE_RULES.safeMarginShare` (6% of the short edge; the story zones for 9:16). One pixel of rounding is allowed.
- **Contrast.** The background is the median luminance of the box's pixels, leaving out pixels within an RGB distance of 48 of any run colour in the frame (the glyphs). If fewer than 10% of pixels remain, the text sits on its own colour, and all pixels count. Each run colour is held to `requiredContrast`: 4.5:1, or 3:1 for text of 32 px and up (24 px bold), in design pixels.
- **Verdicts.** Each is false when anything fails, true when everything measured passes, and null only when nothing could be measured. Skipped runs are named in the `contrast` check's details.

### 2.3 Advisory, never blocking

ADR-253 proposed blocking on a false. This ADR does not. `status`, `passed` and `criticalPass` are unchanged by either measure. A frame box is wider than its ink, so a box can break the margin while the text does not. A failure is recorded in `qaReport` as:

- `warnings`, for example `low contrast on 'KAAE Summit' (1.6:1, needs 3:1)` and `text close to the edge: 'KAAE Summit'`;
- `checks` entries `safeMargins` and `contrast`, with the boxes and ratios.

The office draft alert (`composeOfficeDraftAlert`) adds one line under the check line, in the text and in the caption: "Check before approving: …". It names at most three warnings and counts the rest. `lifecycle-projection.ts` reads them from the task's latest QC run (`draftQcWarnings`). The line is English only, like the check line it follows.

## 3. Consequences

- The Desk shows measured booleans where it showed ○ "not measured", whenever a same-version PNG exists.
- A capture whose PNG arrives after its PPTX was checked keeps nulls until the next QC run.
- Not measured: theme colours, text on a gradient fill, glyph-tight ink boxes, a text shape with no position of its own, and rendered glyph coverage (still null).

## 4. Verification

- `apps/core/test/canva-export-pixels.test.ts` (new, 11 tests). It builds the PPTX and PNG in the test and covers:
  - a compliant design (both true, the grouped frame placed through its group);
  - light-grey text (false, ratio in the warning, verdict unchanged);
  - the large and normal bands;
  - a box past the safe area (false, verdict unchanged);
  - a failed copy check still measured;
  - no PNG (null);
  - a tampered PNG and a PNG of another shape (null);
  - an unresolved theme colour (skipped and named);
  - the real Canva multilingual export with its own PNG (14.5:1; the test sheet's first and last rows break the 72 px margin);
  - the office alert line, and reading warnings from a stored report.
  - Red before: all 11 failed.
- `apps/core/test/lifecycle-office-draft-alert.test.ts` (+2, database). A real outcome projection with a checked PPTX and its same-version PNG writes a passed QC run, measured false, and the alert's line. A PNG from another saved version is not measured. Red before: the alert test fails without the wiring.
- `packages/qa/test/canva-pptx-layout.test.ts` (new, 5 tests): boxes, group scale, a quarter turn, colour inheritance, a frame with no position, refusals.
- Full run of `apps/core/test`, `apps/worker/test`, `packages/creative/test` and `packages/integrations/test`: 5650 passed, 5 skipped, 0 failed (456 files passed, 4 skipped). `packages/qa/test`: 151 passed. `pnpm typecheck` and `pnpm lint` pass.

**Not run:** live Canva, live Telegram, production data.
