# Canva proof plan: heavy sans display capitals (ADR-275)

**Status:** written, NOT run. It needs the art director's Canva session and one import against the
real account; no Canva call was made while writing it.
**Branch:** `claude/display-caps`.
**What it answers:** whether Canva keeps the three things the deck sends for a poster title in
heavy sans capitals, and whether the exact-copy checks read Canva's export correctly. The three
things are:

1. the copy as typed, live and editable;
2. `cap="all"` on its runs, so it draws in capitals;
3. the weighted face, named by the file's own family name.

## 1. The fixture (one PPTX, one import)

Generate it locally. This makes no network call:

```bash
pnpm tsx scripts/proofs/display_caps_proof.ts <outDir>
# writes <outDir>/canva_display_caps_fixture.pptx and <outDir>/report.json
```

The deck's zip carries write times, so every run writes different bytes. Two host runs on
2026-10-02 gave `dbcd03dc…` and `ee2199de…`. Record the SHA-256 of the file you actually import.

The fixture is a 1080x1350 cream poster: the KAAE logo plus three live text objects.

| Object | Copy as typed (`a:t`) | Run properties | Plan record |
|---|---|---|---|
| `Caps text 0` (eyebrow) | `K-12 \| Higher Education` | `cap="all"`, `<a:latin typeface="Inter"/>`, `b="1"`, tracked +0.08em | `fontWeight 700`, `textTransform uppercase` |
| `Caps text 1` (title) | `Peer Review Week` (two runs: `Peer` in KAAE Blue, ` Review Week` in Royal) | `cap="all"`, `<a:latin typeface="Inter ExtraBold"/>`, no `b`, tracking -0.01em, line spacing 0.98 | `fontWeight 800`, `fontFace Inter ExtraBold`, `textTransform uppercase` |
| body | `Join KAAE’s network of peer evaluators.` | `<a:latin typeface="Inter"/>`, no `cap` | none |

Check before importing. The local run must show:
- `capsRuns` = 5;
- typefaces `Inter` and `Inter ExtraBold`;
- `checkAsSent` true;
- `checkBakedCapitals` true;
- `checkBakedCapitalsWithoutPolicy` false;
- `checkCapsOnUntransformedBlock` false.

If any of these differs, stop: the engine and the plan disagree.

## 2. The run (exactly one import, one export)

1. **Import.** Import the fixture once through the existing unattended `/v1/imports` path (memory:
   canva-native-proofs). Use a design title that names it, for example
   `ADR-275 display caps proof 2026-10-xx`. Record:
   - the import job id;
   - the design id;
   - the design's `updated_at`.
2. **Do not edit the design.** Open it in the browser through the art director's session (Control
   Chrome is fine) only to look and take a screenshot. Record:
   - whether the title shows **PEER / REVIEW / WEEK** in capitals in a heavy weight, with PEER in
     blue;
   - whether clicking into the title shows the typed text (`Peer Review Week`) in the editor, or
     capitals written into it;
   - which font name and weight the Canva font menu shows for the title (expected: Inter, ExtraBold
     or 800);
   - the same for the eyebrow (Inter Bold) and the body (Inter Regular).
3. **Export.** Export the same version once as PPTX and once as PNG, both through the existing
   export path that stores bytes and runs the checks. For the PNG, the PPTX reader works from the
   PPTX and the PNG is for looking.
4. **Read the export back with the checks the product uses.** The capture path already does this.
   Do it by hand as well with the plan's policy:

```ts
checkCanvaPptx(exportBytes, [
  'K-12 | Higher Education',
  'Peer Review Week',
  'Join KAAE’s network of peer evaluators.',
], {
  fontsByIndex: ['Inter', 'Inter', 'Inter'],
  uppercaseByIndex: [true, true, false],
});
```

Record from the result:
- `copyPass`, `fontPass` and `shownTexts`;
- `observedFonts`;
- the raw `<a:rPr>` of each title run in the exported slide XML: `cap`, `b`, and `<a:latin typeface>`.

## 3. Pass criteria

| # | Check | Pass |
|---|---|---|
| 1 | Live text | Title, eyebrow and body are editable text objects in Canva and in the exported PPTX (`sourceTextObjects` not null). |
| 2 | Copy exact | `copyPass` true with `uppercaseByIndex`. The body is matched exactly. |
| 3 | Drawn in capitals | The PNG and the editor show the title and eyebrow in capitals. |
| 4 | Stored copy | Canva either keeps `Peer Review Week` under `cap="all"` (best: the office can edit the words as typed), or writes `PEER REVIEW WEEK`. Both pass check 2. Record which one Canva does. |
| 5 | Weight | The title is drawn visibly heavier than the eyebrow's Bold, and the font menu shows ExtraBold or 800. |
| 6 | Face name | `fontPass` true: `Inter ExtraBold` or `Inter` is accepted for Inter (VERIFIED_FONT_NAMES). Anything else is a substitution and fails. |
| 7 | Leading | The title's three lines sit at about 0.98 of the size, without the lines touching. Compare with `en_caps_title.png` from the local proof. |
| 8 | Two colours | PEER in KAAE Blue and REVIEW WEEK in Royal, as separate runs. |

## 4. What each outcome means, and what to change

- **Canva drops `cap="all"` and keeps the typed lower case.** The title arrives in title case.
  Bake capitals into the text for Canva only, which is a change to the copy the office edits. That
  needs an owner decision, because the stored copy must stay as typed. Otherwise keep the transform
  in the preview and accept title case in Canva. Do not ship until the owner chooses.
- **Canva bakes the capitals into the text** (`PEER REVIEW WEEK`, no `cap`). Acceptable: check 2
  passes with the plan's policy. The capture path already passes `uppercaseByIndex` from the plan
  (`importedSourceCapitals`).
- **Canva maps `Inter ExtraBold` to another face, or to Inter Regular.** Re-send with
  `typeface="Inter"` and `b="1"`. This loses 800 for 700. Better, test whether Canva keeps 800
  when sent as Inter with `b="1"` and then set by the native editing API's weight operation. The
  Canva MCP's editing transactions can set weight; that is a separate, approved session. Record
  which works, then change `deckFontFace` (transfer-v2.ts) accordingly.
- **Canva re-wraps the title differently from the preview** (a word drops to a new line). Compare
  Canva's line breaks with the preview's 3 lines. If Canva measures Inter ExtraBold capitals wider,
  the composer must leave the margin `balancedBoxWidths` leaves for Canva on title boxes too.
  Record the measured widths.

## 5. Do not

- Make more than one import of this fixture, or edit the design in Canva.
- Run this against a requester's design or a production task.
- Make any paid model call.
- Delete the proof design: the API cannot, and it stays as the evidence.

## 6. Evidence to save

Save it under `plans/kaae-2025-guideline/DISPLAY_CAPS_CANVA_PROOF.json`:
- the fixture hash;
- the import job, design id and `updated_at`;
- the export hashes;
- the check results;
- the observed `rPr` attributes;
- screenshot paths and the answers to section 3.

Then update ADR-275 section 7 and the FR-015 traceability row.
