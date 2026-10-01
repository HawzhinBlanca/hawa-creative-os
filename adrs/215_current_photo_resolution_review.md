# ADR215 — Measure cutout and current photo resolution with rendering geometry

Date: 2026-10-01. Status: connected and seven-stage engineering verified; production-dump/native/human/product admission pending.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md, MASTER_SPEC; ADR157, ADR170 and ADR214.

## Evidence and reason

Actual synthetic cutout_speaker placement enlarges a 100x200 trimmed portrait
3.04x, yet the solver records no heroUpscale, emits no resolution warning and
retains it despite a supplied sharp cutout fitting at0.253x. The helper only
looks for role=hero, while the recipe uses role=portrait. Final review also
reads saved artDirection.heroUpscale rather than current source/geometry, so
editing size or zoom can make that advisory evidence stale.

## Decision

Share the existing render/transfer cover-crop and contain-placement math in a
pure photo enlargement helper. Solver primary resolution includes its cutout
portrait, measured from the trimmed cutout rather than original photo dimensions.
Invalid cutout dimensions are ordinary recipe infeasibility. ADR214's existing
bounded search can select an admitted sharp alternate without a new model call.
Preserve original warned soft fallback when no sharp feasible source exists.

Core's common QA context reads actual retained photo/cutout byte dimensions.
The art-direction adapter also prefers readable current photo bytes and carries
actual cutout pixels separately from placement metadata. Unreadable existing
cutout pixels are recorded as null and refused as recipe infeasibility rather
than silently certified from metadata.
For cutouts, retain the renderer's declared placement geometry separately from
the actual PNG size, so incorrect size metadata cannot hide actual enlargement.
Current layout crop, zoom and contain placement determine advisory warnings for
every placed source. Saved scale cannot override supplied current evidence.
Candidate ranking uses the shared QA outcome when supplied, rather than a
contrary saved scale; no-QA legacy ranking keeps its recorded fallback.
An unavailable/invalid supplied source is visibly unmeasured. When no current
source evidence was supplied, legacy metadata remains an explicitly historical
fallback; it is not promoted as current measured proof.

Keep existing HERO_UPSCALED for the primary source and use PHOTO_UPSCALED for
supporting images. Missing current dimensions use PHOTO_RESOLUTION_UNMEASURED.
All remain warnings under the existing1.5x soft policy; no new hard defect,
changed contrast/subject/copy/coverage threshold, source replacement in final
QA, layout mutation, regenerated pixels, dependency or provider/repair round.

## Required qualification

Retain pre-fix actual solver/review failures. Verify primary cutout replacement,
soft fallback, invalid-size refusal, current edited geometry and zoom, contain
versus cover, actual PNG dimensions despite incorrect saved metadata, supporting
sources, missing/corrupt sources, exact threshold, original immutability and
replay. Verify actual Core layouts and final QA, saved office review evidence,
local raster and independent editable cutout/source-byte transfer. Connected
tests, strict compilation/build/lint and exact source gate are required. Real
Canva/native/human/taste/product admission remains separate and open.

## Connected evidence

19 pure/local-raster/editable-transfer tests and one actual Core/isolated PostgreSQL/HTTP/office-review check pass. Connected26files510pass/0fail/0skip; strict695 roots, build and lint pass. Original17 red controls, corrected genuine stale-ranking red and introduced fixture/IPC failures are retained in W4_PHOTO_RESOLUTION_REVIEW_PROOF.json. Current source edits produce fresh warnings without mutating layout or adding model calls. Exact clean engineering gate remains pending; no production/native/human/product admission claim.

Exact clean seal 9664a72e passes seven engineering stages: 6875 passed / 0 failed / 67 skipped across 688 passed files / 6 skipped; 695 strict roots and 1768 package checks. Mandatory negative-flag refusal passes. Raw production-dump Stage 3 remains skipped: previous automatic approval review requires explicit transfer authorization, still pending. No all-eight qualification, deployment or native/human/product admission claim. W4_PHOTO_RESOLUTION_REVIEW_GATE_EVIDENCE.json retains actual receipts.
