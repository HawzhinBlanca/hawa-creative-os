# T03 Proof: Layout DSL v2, Validator and Deterministic Metrics

- **Date / Timestamp**: 2026-09-14T09:31:00Z (12:31:00 local)
- **Branch**: `studio-v2`
- **Component**: `@hawa/creative` (`src/studio/layout-v2.ts`, `src/studio/validate-layout-v2.ts`, `src/studio/layout-metrics.ts`)

---

## 1. Overview of Deliverables

1. **Layout DSL v2 (`packages/creative/src/studio/layout-v2.ts`)**:
   - Strongly-typed TypeScript interfaces and Zod runtime validation schemas for `StudioLayoutV2`, `GridConfig`, `ArtConfig`, `ShapeElement`, `TextElement`, `Box`, `Hex`.
   - Constrained shapes (kinds: `rect`, `roundRect`, `ellipse`, `line`; roles: `rule`, `panel`, `accent`, `frame`).
   - Constrained text elements with `copyIndex`, typographic roles, font size, line height, letter spacing, alignment, and optional RTL flag.
   - Max 40 text elements, max 40 shape elements.

2. **Deterministic Server Validator (`packages/creative/src/studio/validate-layout-v2.ts`)**:
   - Implements hard-fail validation returning stable error codes and granular messages.
   - Automatically normalizes Arabic-script text blocks to `scriptFonts.arabic` (`Noto Sans Arabic`), right alignment (`align: 'right'`), and RTL (`rtl: true`) per ADR-028/029.
   - Enforces brand palette compliance, bounds within safe margins (≥ 6% short edge), non-overlapping text and logo boxes, typographic size hierarchy, logo aspect ratio & clear space (0.5× logo height), art safety keywords, and contrast threshold.

3. **Deterministic Layout Metrics Engine (`packages/creative/src/studio/layout-metrics.ts`)**:
   - Returns objective layout facts: `alignmentScore` (target ≥ 0.85), `whitespaceRatio` (target 0.35–0.75), `balanceOffset` (% ink centroid offset from center), `hierarchyRatio` (title/body), `bodyCharsPerLine`, `lines` per copy block, `contrastP05` per box, `marginMin`, `overlapCount`, and `logoWidthPct`.

---

## 2. Hard-Fail Validation Code Mapping to Test Names

Every code defined in Section 5.2 of `GEMINI_TASK_SHEET.md` is strictly unit-tested with an adversarial failing test case in `packages/creative/test/studio-validator.test.ts`:

| Validation Code | Specification Rule | Unit Test Name |
|---|---|---|
| `DIMENSIONS_CHANGED` | width/height must equal request | `code DIMENSIONS_CHANGED: rejects when width or height differ from request` |
| `COPY_PLACEMENT` | every copyIndex 0..N-1 exactly once | `code COPY_PLACEMENT: rejects missing or duplicated copyIndex` |
| `FONT_NOT_ADMITTED` | Latin blocks must use reference or draft font | `code FONT_NOT_ADMITTED: rejects unadmitted Latin font` |
| `PALETTE` | background, art scrim, shapes, text must use palette | `code PALETTE: rejects non-brand hex color in shapes or text` |
| `BOUNDS` | elements inside canvas; text & logo inside 6% safe margin | `code BOUNDS: rejects element or margin violating safe margin (6% short edge)` |
| `OVERLAP` | no text–text or text–logo collisions; non-panel shapes cannot intersect text | `code OVERLAP: rejects text-text or rule-text collision` |
| `MIN_SIZE` | body ≥ 1.6% width, text ≥ 12px, title ≥ 2.2× body | `code MIN_SIZE: rejects body text smaller than 1.6% width or title < 2.2x body` |
| `LINE_HEIGHT` | Latin 1.2–1.5; Arabic script 1.6–1.9 | `code LINE_HEIGHT: rejects Latin line-height outside [1.2, 1.5] or Arabic outside [1.6, 1.9]` |
| `LETTER_SPACING` | Arabic = 0; Latin \|ls\| ≤ 0.1em; body = 0 | `code LETTER_SPACING: rejects letter-spacing on Arabic or body copy` |
| `HIERARCHY` | title > subtitle ≥ date/venue ≥ body ≥ footer | `code HIERARCHY: rejects subtitle larger than title or body larger than date` |
| `LOGO` | width ≥ max(100px, 8% width); aspect ±1%; 0.5× clear space | `code LOGO: rejects width < 8% or clear space violation` |
| `ART_SAFETY` | prompt contains no forbidden words; calmRegion covers all text | `code ART_SAFETY: rejects forbidden words (person, face, logo) in prompt or text outside calmRegion` |
| `CONTRAST` | p05 text contrast ≥ 4.5:1 (≥ 3:1 for large/bold) | `code CONTRAST: rejects text box with insufficient contrast (< 4.5:1 for body)` |
| `COUNTS` | text ≤ 40, shapes ≤ 40 | `code COUNTS: rejects text or shape arrays exceeding 40 elements` |

### Aspect Ratio Format Conformance Tests
- `passes 1080x1350 (4:5 Portrait)`
- `passes 1080x1080 (1:1 Square)`
- `passes 1080x1920 (9:16 Story)`
- `passes 1240x1754 (A4 Document)`
- `passes 1920x1080 (16:9 Landscape Screen)`

### Arabic Script Normalization Test
- `normalizes Arabic blocks to Noto Sans Arabic, right-aligned, rtl:true`

---

## 3. Metrics Engine Hand-Calculated Verification

Tested in `packages/creative/test/studio-metrics.test.ts`:
- **Canvas**: 1000×1000 px, margin = 100 px, 6 columns.
- **Fixture Elements**:
  - Logo: 100×100 at (100, 100). Ink Area = 10,000 px².
  - Title: 800×100 at (100, 250), fontSize 50. Ink Area = 80,000 px².
  - Body: 800×100 at (100, 400), fontSize 25. Ink Area = 80,000 px².
- **Hand-Computed vs Measured Results**:
  - `alignmentScore`: 5 aligned edges out of 6 total edges = **0.833** (verified: `0.833`).
  - `whitespaceRatio`: 1 - (170,000 / 1,000,000) = **0.830** (verified: `0.830`).
  - `balanceOffset`: Centroid at (479.412, 361.765) vs center (500, 500) -> dx = -0.020588, dy = -0.138235 -> Euclidean offset = **13.98%** (verified: `13.98`).
  - `hierarchyRatio`: 50 / 25 = **2.00** (verified: `2.00`).
  - `logoWidthPct`: 100 / 1000 = **10.00%** (verified: `10.00`).
  - `marginMin`: **100 px** (verified: `100`).
  - `overlapCount`: **0** (verified: `0`; adversarial overlap test verified: `1`).
  - `bodyCharsPerLine`: 89 chars / 3 lines = **29.7** (verified: `29.7`).

---

## 4. Acceptance Test Execution Output

```bash
pnpm vitest run packages/creative/test/studio-*.test.ts
```

```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ packages/creative/test/studio-metrics.test.ts (2 tests) 2ms
 ✓ packages/creative/test/studio-validator.test.ts (20 tests) 4ms

 Test Files  2 passed (2)
      Tests  22 passed (22)
   Start at  12:30:06
   Duration  148ms (transform 83ms, setup 0ms, import 98ms, tests 6ms, environment 0ms)
```

---

## 5. Monorepo Quality Gates Verification

- **`pnpm --filter @hawa/creative build`**: Clean TypeScript compilation (`dist/index.js`, `dist/index.d.ts`).
- **`pnpm typecheck`**: Exit 0 across all 8 workspace packages and applications.
- **`pnpm test`**: 117 test files passed (855 tests passed, 12 skipped, 0 failed).
- **`pnpm security:scan`**: 0 secrets in committable files.
- **`python3 scripts/validate_pack.py`**: PASS=509 WARN=0 FAIL=0.
