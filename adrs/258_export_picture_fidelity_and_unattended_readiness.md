# ADR-258: The Source's Pictures Checked in the Canva Export, and What Unattended Generation Already Does

**Date:** 2026-10-02
**Status:** Accepted (branch `claude/hawzhin-support`; not deployed)
**Requirements:** FR-029, FR-043 (editable, exact output), FR-060, FR-061 (durable generation), NFR-006
**Related:** ADR-257 (export contrast and margins; advisory measures), ADR-256 (Codex: hawzhin workspace customer boundary), ADR-082 (export copy and direction check), ADR-108 (uncertain provider effects)

## Context

The hawzhin.app handoff (`output/handoffs/2026-10-02/CLAUDE_OPUS_55_HAWZHIN_INTEGRATION.md`) asks the supporting lane for three things:
- unattended native import and export readiness;
- exact export fidelity;
- proof of resumability.

It also asks for a narrow contract the customer API can use.

### What production already does (read-only evidence, 2026-10-02)

**Unattended import works through the official API.**
- Since 2026-09-29, production has made 11 Canva designs from Studio transfers with nobody clicking anything, each followed by a PNG and a PPTX export and the copy check. Two of them had six photos, including the one delivered design (task 5edca743).
- The path is `POST /v1/imports`: binary body, `Import-Metadata` declaring the PPTX MIME type (`canva-connect-client.ts:542`).
- It runs under `canva_remote_operations`:
  - an idempotency key and a request hash;
  - "uncertain" is never sent again;
  - 429 is held and retried;
  - a stranded import is resumed (`canva-connect-service.ts:380–470`).

**The "Unsupported file format ZIP" failure in Codex's acceptance is a different call.**
- `NATIVE_CANVA_IMPORT_RECEIPT.json` records two `400 Unsupported file format ZIP` answers, plus a retry "with Content-Disposition".
- The response shape (an empty status object and a bare string body) is not the shape of a `/v1/imports` answer. That call was most likely an asset upload: asset uploads accept images and video, never PPTX. ^[inferred]
- Production's own path imports the same kind of file unattended.
- **Verified 2026-10-02** (owner-authorised supervised call): Codex's approved `hero_storyboard.pptx` (sha256 72dd1bdb…, deflated) imported unattended through `POST /v1/imports`, creating design DAHW27HkZW0. PPTX and PNG exports were retrieved.
  - All 5 pictures are at identical boxes, and the text is exact.
  - In the photo area, 0.09% of pixels differ by more than 10% from the Studio render.
  - Receipt: `output/handoffs/2026-10-02/CLAUDE_CANVA_IMPORT_PROBE_RECEIPT.json` (main checkout, gitignored output).

**The export copy check is real, but nothing checks pictures.**
- The export check (ADR-082) proves exact copy, declared fonts and paragraph direction.
- It records `logoVerification: not_qualified` and `layoutVerification: visual_review_required`. Nothing checked that the photos and the logo survived.

### What the Canva round trip does to pictures

Measured on task 5edca743: the stored source PPTX (blob `bd5b0e17…`) against the PPTX Canva exported (`6338add7…`).

- **Element type.** Every `p:pic` comes back as a `p:sp` with an image fill. Counting `p:pic` reads the export as having **zero photos**.
- **Media.** Source media of 1.93 MB comes back as 0.91 MB (ratio 0.47): re-encoded and downsampled, and renamed.
- **Position.** Boxes are preserved to the pixel (3 photos and the 108×108 logo at 76,76). The page height is rounded down by 6350 EMU (two-thirds of a pixel).
- **Recognisability.** Each source picture is within difference-hash distance 0–8 of its export. Unrelated pairs measure 16 or more.
- **Transparency.** The logo kept it: 69% transparent in the source, 71% in the export.
- **Added pictures.** Canva added a JPEG (used as two image fills under the titles) that is not in the source. It is an effect rasterised into a picture.
- **Text.** The text is exact. The invisible right-to-left mark before the English titles was split into its own run, and `Verdana` is reported as `Verdana Bold`.

## Decision

1. **Read pictures as Canva writes them.**
   - `readPptxPictures` (`packages/qa/src/canva-pptx-layout.ts`) reads `p:pic` and image-filled `p:sp`, through groups, with ADR-257's transforms.
   - It returns each picture's box (EMU) and media part, plus the media bytes.
   - It uses the hardened unzip and XML reader (`unzipPptxParts`, `parsePptxXml`).

2. **Fingerprint pictures without an image library.**
   - `imageFingerprint` (`packages/creative/src/studio/export-image-fidelity.ts`) draws each picture at 9×8 with the renderer's own rsvg-convert, using files beside the SVG (the inline data-URI guard stays on).
   - It records a 64-bit difference hash and the transparent share. Transparent pixels are read over white, so a logo is hashed as it is seen.

3. **Pair source and export pictures** (`checkExportPictures`, `apps/core/src/services/export-picture-fidelity.ts`).
   - Pairing is by place: every edge within 0.5% of the page, so Canva's rounding of the page height does not matter. Then by picture: distance at most 10.
   - A picture found only elsewhere is `moved`. One found nowhere is `missing`.
   - The **logo** is the source picture at the box the transfer manifest records (`manifest.logo`, layout pixels, 9525 EMU each). It is reported as `preserved`, `moved`, `missing`, `transparency_lost` or `not_in_source`.
   - Pictures Canva added are counted (`addedByProvider`). They do not fail the check.

4. **Recorded on every capture, advisory.**
   - `addPictureFidelity` runs where a capture's QC run is recorded: the bridge's first revision and `recordCheckedExportQc` (re-checks, sweeps, re-drives).
   - It stores `qaReport.pictureFidelity` and a `pictureFidelity` check. Missing, moved or alpha-lost logos and photos are added to `qaReport.warnings`, which ADR-257's office alert already prints as "Check before approving: …".
   - It never changes `passed` or `criticalPass`.
   - A design not imported from an editable source records `{ measured: false }`. A measurement error is recorded and never blocks the capture.

5. **Customer download eligibility reads it.** The narrow contract (handoff response) offers an artifact to a customer only when `passed && criticalPass && pictureFidelity.pass !== false`. Staff approval, Drive publication and governance are unchanged.

## Consequences

- A lost photo or logo, which the exact-copy check could not see, is now recorded and shown to the office before approval.
- The transparency of the official logo is now checked on the shipped file.
- About 50–150 ms are added per capture (one rsvg-convert per picture, at most a few). It runs inside the existing QC transaction.
- **Limits:**
  - A picture cropped very differently (Canva reframing) can read as missing.
  - The hash says "same picture", not "same resolution". `byteRatio` reports re-encoding but does not judge print quality.
  - The added-picture count says an effect was rasterised but does not judge whether that hurts editability.
- **Not done here:**
  - Automatic PDF capture: PDF exists only through the office export route (`canva-connect-service.ts:580`), with hash.
  - A native-UI check of RTL joining in the exported design.

## Verification

- `apps/core/test/export-picture-fidelity.test.ts`: 11 tests.
  - 8 unit tests on synthetic pictures (no client media), covering:
    - re-encoded, downsampled and renamed pictures pass;
    - a missing photo, a replaced photo, a missing logo, a moved logo and a logo with lost alpha each fail and are named;
    - a rasterised effect is counted;
    - no logo box.
  - 3 test-database tests through `projectLifecycleDesignOutcome` (bridge path): the stored QC report, the unchanged verdict, and the office alert line. These 3 failed before the bridge path was wired.
- **Real files, read-only:**
  - task 5edca743's stored source and export give pass, logo preserved, 4/4 matched, 2 added, byte ratio 0.47;
  - distance matrix: matches 0–8, unrelated pairs ≥ 16.
- **Regression:**
  - 45 files, 619 tests (Canva, export, QC, qa);
  - 192 files, 2406 passed and 3 skipped (with lifecycle, creative and qa);
  - 11 files, 51 tests on resumability (rate limit, stranded, re-drive, kill and uncertain recovery, durable workflow).
