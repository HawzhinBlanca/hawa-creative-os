# Merge note for Codex: ADR-236 (KAAE brand guideline palette, light first)

**Branch:** `claude/kaae-light-guideline`, from production `3726c8c6`.
**Edits in `packages/creative/**`:** made with the owner's authorisation for this change (2026-10-01).
**Line numbers:** base `3726c8c6` → this branch (`git diff -U0 3726c8c6`).
**Overlap with `origin/codex/research-grade-design-system`:** checked against the branch as fetched on 2026-10-01.

## Files Codex also edits

### `packages/creative/src/studio/art-direction/solver.ts`

Most of these hunks are one-line colour swaps (`this.tones.navy` becomes `background` from `this.ground()`).

| Base lines | Change | Overlap with Codex |
|---|---|---|
| 55 (after `align?`) | New `ArtDirectionParams.paper?: 'cream' \| 'white'`. | Codex adds `backgroundIntent/Mode/ColorIndex` after `surfaceTone` (base 50). Separate lines; keep both. |
| 702 (after `align()`) | New methods `isLight()`, `paper()` and `ground()`. `ground()` returns `{ background, colours }`: paper with the cream palette, or navy with the navy palette. | None. |
| 906, 930, 934, 970, 980 | `heroFadeReport`: the colours and the fade colour come from `ground()`, and so does the background in both `finish` calls. | None. |
| 1030 | `heroCard`: `finish` background is `isLight() ? paper() : navy`, with a comment. | None. |
| 1051, 1073, 1095, 1098, 1102, 1109 | `heroPlate`: the plate stays navy; the rest-lines' colours, the scrim colours and the background come from `ground()`. | None. |
| 1125, 1155, 1160 | `scrimCaption`: the colours, the scrim colour and the background come from `ground()`. | None. |
| 1201, 1222 | `cutoutSpeaker`: the colours line and the `finish` background come from `ground()`. | **Conflict.** Base 1201 is the line right after the one Codex rewrites (the `cutoutPixelSize` guard, base 1200). Keep Codex's guard, then my `const { background, colours } = this.ground();` in place of `const colours = surfacePalette(this.tones, 'navy');`. |
| 1227, 1260-1265, 1281 | `fadeToPaper`: doc comment; on white paper a full-width navy band replaces the plate (`band`); the background is `this.paper()`. | None. |

`heroStoryboard` and `editorialColours` are not touched. Codex's `editorialColours()` already defaults to cream; consider switching it to `this.ground()` / `this.paper()` so that `paper: 'white'` reaches the editorial recipes too.

### `packages/creative/src/studio/pipeline-v3.ts`

| Base lines | Change | Overlap with Codex |
|---|---|---|
| 4 | `import { brandTones } from './art-direction/solver.js';` | Codex edits the import block at 1-8. Keep both. |
| 275 | New exported `nearestGroundColour()`: grounds never snap to a neutral near-black ink when the palette has a dark blue. | None. |
| 320, 323 (`conformToHouseRules`) | The background, art scrim and `panel` shape colours use `nearestGroundColour`. | Codex's hunk at 770 is far away. |
| 863-869 (`conformColoursOnly`) | The background, panel shapes and overlays use `nearestGroundColour`. | Codex's hunk at 810 ends before 863. |

### `packages/creative/src/studio/art-direction/generate.ts`

| Base lines | Change | Overlap with Codex |
|---|---|---|
| 19 | `import { resolveSurfaceTone, type TonePreference } from './tone.js';` | None. |
| 119, 130, 142, 150 | System-prompt wording: the navy-specific phrases are made tone-neutral; the `surfaceTone` parameter is described. | **Conflict.** Codex rewrote this prompt wholesale (no navy defaults). Take Codex's prompt and re-add only my `surfaceTone` line (base 150), or its equivalent. |
| 192 | `GenerateArtDirectedOptions.tonePreference?`. | None. |
| 268 | User prompt: a `GROUND:` line before `TASK:` when a tone preference is set. | None. |
| 384-412 (`solveConcepts`) | `toned()` sets every attempt's `surfaceTone` and `paper` with `resolveSurfaceTone`; `tries.map(toned)`; the first-attempt check is by index (`k > 0`), because the mapped tries are copies. | Codex changes `solveConcepts`/`defaultChoice` around supporting photos. Re-apply `.map(toned)` to the final `tries` list, and the index check. |

### `packages/creative/src/studio/art-direction/recipes.ts`

Lines 70, 103 and 125: the `summary` text of `hero_fade_report`, `scrim_caption` and `cutout_speaker` names the light page as well as navy. Codex does not edit these three summaries.

### `apps/core/src/services/design-studio/stages/layouts.stage.ts` and `types.ts`

Codex changes one line in each. Mine:

- `layouts.stage.ts`: 245 passes `tonePreference` to the art-directed call; 482 adds `promotedRules` to the `layoutBriefV3` Pick; 491 adds the "Client house rules" line.
- `types.ts`: 43 adds `CreativeBrief.tonePreference`.

Neither should conflict textually.

## Files only this branch edits

| File | Lines | Change |
|---|---|---|
| `packages/creative/src/studio/art-direction/tone.ts` | new | `tonePreferenceFromWords`, `toneGroundHex`, `resolveSurfaceTone`, `DARK_HERO_LUMINANCE`. |
| `packages/creative/src/studio/art-direction/index.ts` | 55 | Exports from `tone.js`. |
| `packages/creative/src/studio/layout-generator-v3.ts` | 339, 406, 529 | A missing ground falls back to the lightest colour. |
| `packages/creative/src/studio/layout-generator-v3.ts` | 783 | `balanceCanvasMargins` keeps edge-bled bands anchored. |
| `packages/creative/src/studio/layout-generator-v3.ts` | 1358-1366, 1386 | Tone-neutral prompt: contrast, light-canvas bands, calm region. |
| `packages/creative/assets/kaae-reference.json` | | The palette, `paletteFallbacks`, `brandColors`, `colorUsage`, `colorSource`, `retrievedAt`, and `artDirection` R2/R3/R7/R8 plus a new R11. |
| `packages/domain/src/fixtures/kaae-client-dna.ts` | | `colors` set to the guideline palette. |
| `config/clients/kaae.dna.json`, `config/clients/kaae.dna.yaml` | | `brand.colors` set to the guideline palette. |
| `apps/core/src/services/client-design-reference.ts` | | `paletteFallbacksOf()`: the lightest background colour. |
| `apps/core/src/services/design-studio/stages/brief.stage.ts` | | `brief.tonePreference` from the requester's words; `requestedBackgroundFor` honours it and snaps with `nearestGroundColour`. |

## Semantic points for Codex's own code

- **`background-planning.ts` / `applyContentBackground`.** KAAE's palette now begins `#FFFFFF, #FFF2DB` and ends with the black ink `#000000`. A content-derived background must not pick the ink; `nearestGroundColour` is the guard. `backgroundColorIndex` values that indexed the old palette now point at different colours.
- **Tests with the old KAAE palette.** Any Codex test that loads `kaae-reference.json` and expects `#0A1628`/`#F7B500`/`#FDF8F3` needs the guideline colours. Updated on this branch: `style-spec`, `title-color`, `art-direction-e2e`, `design-studio-orchestrator`, `client-rules`, `studio-asset-resolution`.
- **Reference hash.** The reference hash changes, so in-flight runs refuse with `CLIENT_REFERENCE_CHANGED` after deploy.
