# ADR-290: Sorani Shaping Is Checked on the Raster, Advisory

**Date:** 2026-10-03
**Status:** Accepted (branch `claude/soranicheck`; advisory only, nothing deployed)
**Requirements:** FR-034 (Sorani script, digits, fonts, mixed direction), FR-035 (Arabic shaping and direction), FR-038 (QA of glyphs and bidi behaviour)
**Related:** ADR-118 (Pango text measurement), ADR-257 (advisory checks never change the verdict), ADR-258 (export picture and line checks), ADR-273 (office posts as fixtures)

## Context

Nothing checked that the Kurdish text in a picture is drawn correctly. The copy checks (`checkCanvaPptx`,
`checkCanvaPdf`) compare characters; ADR-258's `checkTextLines` counts lines. Letters drawn unjoined, a
line drawn in reverse, boxes for missing glyphs, a face the rasteriser substituted (fc-match and the font
probes miss some substitutions) or a re-wrapped line all passed every check we had. A native reader
catches them; the office should not have to be the test.

## Decision

1. **`checkTextShaping` (packages/creative/src/studio/export-text-shaping.ts) draws each designed line
   itself and compares the drawing with the line in the picture.** The line is shaped with the font
   file the design was measured with (fontkit, which applies the face's GSUB joining forms and GPOS mark
   positions) after the Unicode bidi algorithm (bidi-js, already in the lockfile) has split it into
   directional runs and put them in visual order. The outlines are rasterised in-process (coverage,
   four sub-rows a pixel). The picture's ink is read in the block's box: exactly, by unmixing the text
   colour against the text-free render (`noTextPng`), or by distance from the text colour for a
   provider's export. The ink is split into lines, each dot and mark going with the letter body it
   sits on. Each line is matched with its drawing by normalised cross-correlation of the two blurred
   inks, in windows two ems wide, so one broken join fails its window in a long line. Each run of
   letters between digits or punctuation finds its own place: a provider's digits may be narrower than
   the bundled face's.
2. **A failing line is explained by drawing the defect.** The line is drawn reversed, with a
   left-to-right base, and with every letter isolated, and the hypothesis that matches names the
   verdict. Per line: `ok`, `wrapped-differently` (a run of the block's words matches the line instead),
   `shaping-mismatch` (unjoined letters or another face), `missing-glyphs` (hollow boxes the height of a
   letter), `wrong-direction`.
3. **Two readings, two calibrations.** The Studio render, read exactly, must reach 0.93 in every window,
   blurred by 0.035 em. A provider's export, read by colour with ±2.5% scale slack, must reach 0.90,
   blurred by 0.05 em. Digits, punctuation and characters drawn from a fallback face are not scored, but
   they keep their place in the line. In a provider's export, so is every word that needs a fallback
   face, because the provider draws such a word from one face of its own.
4. **Advisory, next to the ADR-258 checks.**
   - The Canva QC record gets `textShaping` (`checkExportTextShaping` on the same-version PNG against the
     editable source's transfer plan, with run colours from the source) and a `textShaping` entry in
     `checks`. The office alert names each block Canva drew other than designed.
   - The Studio QA stage checks the render that ships against its text-free render and adds a
     `TEXT_SHAPING_MISMATCH` warning finding.
   - Neither changes `passed`, `criticalPass` or the download verdict. A check that cannot run records
     `{ measured: false, reason }`.
5. **Shaping never shares a fontkit instance with drawing.** fontkit caches a glyph object by id with
   the code points it was first created with, and its Arabic shaper reads joining types from those code
   points. Reading the outline of a composite glyph creates its components with no code points. In IBM
   Plex Sans Arabic Bold the final U+06D5 is built on the heh glyph, so after one line with U+06D5 was
   drawn, every later U+0647 shaped as non-joining: a title measured 506 px instead of 529. The check
   keeps one parsed copy of each face for shaping and one for outlines, and never hands fontkit a
   default-ignorable character: it cuts the text there, which is what a ZWNJ does to joining. Where a
   face change cuts a word, each side is shaped with a ZWJ standing for the letter across the cut, so
   letters keep their joined forms as they do in Pango.

## Calibration (`scripts/proofs/sorani_shaping_calibration.ts`, output/proofs/2026-10-03-sorani-shaping/calibration.json)

The correct renders are the six Sorani office posts (15 Kurdish blocks, ADR-273), rendered on this host
with the bundled faces pinned (ADR-118).

- **Correct renders.** 15 of 15 blocks pass in both readings. The lowest window is 0.982 read exactly
  and 0.992 read by colour.
- **Negative controls.** Every control is applied to every block it can apply to: ZWNJ between every
  letter, one ZWNJ breaking one drawn join, characters reversed, the block drawn in another bundled face,
  the last word moved to the next line, and two characters no face has.
  - Read exactly: 88 of 88 detected. 86 are named as the defect; one re-wrap that pushed a line out of
    its box reads as `shaping-mismatch`, and one box drawn at 24 px is too small for the box test. The
    highest score of any control is 0.852, a substituted face (pass mark 0.93).
  - Read by colour: 84 of 88 detected. The four misses are all Noto Sans Arabic drawn as Vazirmatn or the
    reverse, at up to 0.929. Those two faces differ less than Canva's build of a face differs from ours.
    One broken join reached 0.894 (pass mark 0.90).
- **Real Canva exports.** Seven sheets on record (55 Kurdish or Arabic blocks, 67 lines).
  - Every block in Noto Sans Arabic or IBM Plex Sans Arabic passes, the mixed Latin and digit lines
    included; the lowest is 0.911.
  - One block is not measured: it holds an emoji the renderer refuses.
  - Three blocks set in Cairo are flagged `shaping-mismatch`. The bundled Cairo has no glyphs for the
    Sorani letters U+06B5 and U+06CE, so the Studio draws them from IBM Plex Sans Arabic, while Canva draws the
    whole word in its own Cairo and the joined forms around those letters differ. The difference is
    visible but not broken shaping. The same check passes the Studio's own render of those blocks.
- **Time on this Mac.** A poster's check takes up to 0.35 s read exactly and up to 1.0 s by colour. A
  failing poster takes up to 1.5 s, because the defect hypotheses are drawn too. One process, no model.

## Consequences

- A broken join, a reversed line, missing glyphs or a re-wrap in a Canva export is named in the office
  alert with the block's opening words, and the Studio render's own drawing is checked before review.
- **Limits.**
  - The reference is fontkit, not HarfBuzz. They agree on every bundled Arabic face measured here
    (Studio renders at 0.98 or better), but a face fontkit shapes wrongly would read as a mismatch.
  - Read by colour, a substitute face as close as Vazirmatn is to Noto Sans Arabic is not always seen.
  - Digits and punctuation are not scored, so their order inside a number is not checked; their place
    in the line is.
  - The Canva check reads the transfer plan's sizes, so a block the renderer shrank to fit (an eyebrow)
    is checked at its planned size.
  - ~~The check is synchronous: up to about a second of Core's event loop per Canva capture.~~ Resolved by
    the addendum below: Core runs it on a worker thread.
- **Open:**
  - ~~The renderer's own fontkit measurement shares one instance between layout and bbox reads.~~
    Resolved in release-3: `render-layout-v2.ts` reads every ink box (the ink-width probe, line ink
    clearance, the drawn block's ink extent) from an outline twin parsed from the same bytes, never from
    the shaping font. Reproduced before the fix in a fresh process: one line ending in U+06D5 had its
    ink read first, then a title with heh measured 541 px against 519 clean
    (`packages/creative/test/font-outline-isolation.test.ts`). The direction depends on the line read
    first (+4% or -6.5% in a direct fontkit probe), so wraps, fits and the copy-fit check were decided
    by what the long-running Core process happened to draw earlier.
  - Make the check blocking only after it has run on live exports for a while.
  - Re-run the calibration inside the core image.

## Addendum (2026-10-03): the check runs off Core's event loop

**Branch:** `claude/shapingworker` (from `claude/release-3`; nothing deployed).

The check is synchronous CPU work: the blocks (`textShapingBlocks`: fontkit fitting and the Pango
fallback query, 0.4 to 0.6 s on a Canva sheet) and the raster comparison (0.6 to 0.9 s). In Core both ran
on the main thread, in the Canva QC recording and in the Studio QA stage, so HTTP, Telegram replies and
Restate handlers waited up to 1.5 s on every capture and every QA.

1. **One job, plain data** (`packages/creative/src/studio/text-shaping-job.ts`). `runTextShapingJob` takes
   PNG bytes (and the text-free PNG), the layout's text blocks, the copy, the scale (or the plan's width,
   read against the picture) and the run colours, and returns exactly what the in-process path returned:
   the `checkTextShaping` report, or `{ measured: false, reason }` when no block has Arabic-script copy.
   Faces travel as paths: the pool pins `fontsDir` to the caller's `defaultFontsDir()` before the job
   leaves the thread, so the worker opens the same pinned files and builds the same fontconfig file.
   The worker keeps the check's own font cache, one shaping and one outline instance per face, as on
   the main thread (rule 5); nothing parsed crosses the thread boundary.
2. **A small `worker_threads` pool** (`text-shaping-pool.ts`, no dependency; nothing in the repository ran
   CPU work on a thread before). One worker by default (`HAWA_TEXT_SHAPING_WORKERS`, 1 to 8), started on
   first use, warm afterwards. Idle workers are unreferenced, so they never keep a process alive.
   - **Deadline per call**, counted from the call, 5 s by default (`HAWA_TEXT_SHAPING_TIMEOUT_MS`, or per
     call). A queued job is dropped; a running job's worker is terminated (synchronous work cannot be
     interrupted otherwise) and the next job starts a new one. Recorded as `{ measured: false, reason:
     'timeout' }`.
   - **A worker that dies** (an exit, an uncaught error, an entry that will not load) answers its job
     `worker-failed`; the next job gets a fresh worker. A check that throws inside the worker is
     answered with its message and recorded as `Not measured: <message>`, as the callers recorded it
     in-process.
   - **Bounded queue** (8 by default, `HAWA_TEXT_SHAPING_QUEUE`): past it a call answers `queue-full` at
     once instead of waiting behind a backlog it would time out in.
   - Nothing rejects. Core's QC records any of these as not measured, with a `textShaping` check of
     `passed: null`, exactly as it records a check that threw; the QA stage records it as not measured.
     Neither changes `passed`, `criticalPass` or the download verdict (rule 4 is unchanged).
3. **Core.** `checkExportTextShapingOffThread` (export-picture-fidelity.ts) validates the manifest and reads
   the editable source's run colours on the main thread (milliseconds), then hands the job to the
   process's pool; `addTextShaping` awaits it. `shapingOfRender` in the QA stage does the same with the
   render and its text-free render. The in-process `checkExportTextShaping` stays for scripts and tests
   and shares the job builder, so the two paths cannot drift. Core's shutdown hook closes the pool after
   the HTTP server has closed: a check still running answers `shut-down`, and the threads have exited
   before the process does.
4. **Evidence** (`packages/creative/test/text-shaping-pool.test.ts`, `apps/core/test/export-text-shaping.test.ts`,
   `apps/core/test/qa-stage-text-shaping.test.ts`, `apps/core/test/export-picture-fidelity.test.ts`).
   - **Parity.** The worker's report equals the in-process report, field by field (every verdict, score,
     width ratio, detail, warning and unmeasured block; only the wall time `ms` differs): the six Sorani
     office posts read exactly and by colour, the six negative controls on one post read both ways, the
     four Canva sheets and a sheet checked against swapped copy (29 reports), plus a check that throws (same
     message) and a design with no Arabic-script copy (same words); through Core's export path, the four
     sheets and the swapped sheet with the office's words.
   - **Event loop.** A 50 ms interval during the slowest sheet (group 4, read by colour), three runs on this
     Mac: in-process the longest gap was 1292 to 1368 ms over a 1282 to 1358 ms check; on the worker it was
     51 ms over a 890 to 911 ms check. The test requires the gap on the worker to stay under 250 ms and
     under a third of the check's time.
   - **Failure.** A hung worker is terminated at its deadline and the next job runs on a new one; a queued
     job past its deadline is dropped without stopping the running one; workers that exit or throw answer
     `worker-failed` and are replaced; a missing entry answers `worker-failed`; a full queue answers at
     once; closing answers waiting and running jobs `shut-down` and leaves no thread. On the test database
     the QC run of a real Canva sheet, with a 100 ms deadline, records `{ measured: false, reason:
     'timeout' }` and a `textShaping` check of `passed: null`, and the run is still recorded and passes.
5. **Limits.**
   - The PNG bytes are copied to the worker (a 1080 x 1350 sheet is about 1 to 2 MB), not transferred: the
     caller keeps its buffer.
   - A worker holds its own parsed faces and the creative module (tens of MB). One worker is the default;
     more only buy parallel checks.
   - A Canva capture now holds its QC transaction (and the task's row lock) while it awaits the check, as
     it already did for the picture check; the deadline bounds the wait at 5 s.
   - `checkTextLines` (ADR-258) still decodes and counts lines on the main thread (tens of milliseconds);
     it was not moved.
