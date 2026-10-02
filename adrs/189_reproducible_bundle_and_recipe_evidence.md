# ADR-189: Reproducible bundle and explicit recipe evidence

Date: 2026-10-01
Status: implemented; exact combined engineering qualified, native/human admission open
Requirements: FR-038, FR-041, FR-074, NFR-014, NFR-025
Sources: docs/05_CREATIVE_ENGINE.md; docs/11_QA_RTL_MULTILINGUAL.md; MASTER_SPEC.md; ADR172

## Observed gaps

The first combined gate on21896bff passed6424 tests and failed two. Standalone
preflight did not build Desk's actual Vite bundle before its budget test. Earlier
checkouts happened to contain an ignored dist directory. Reproducible qualification
must build that prerequisite rather than depend on an earlier local artifact.

The expanded twelve-recipe geometry catalogue has seven recipes represented in the
existing office-published data. Five new geometries have no admitted example there.
The historic dataset test incorrectly equated catalogue membership with coverage.
Neither changing the catalogue nor passing geometry controls creates human examples.

The ordinary gate already ran its negative refusal drill during evidence emission.
The earlier implementation checkpoint incorrectly claimed it did not; that claim is
retracted here. Its output was discarded and a failure was discovered only after the
full suite. Move the same drill earlier and retain its diagnostic output.

## Decision

Build Desk in the mandatory first preflight stage. Keep the real entry/lazy-chunk
size checks and fail if the build fails. No test or stage is skipped.

Retain the exact seven-recipe historical dataset, its hashes/provenance and8–12
asset bound. Independently report eligible, represented and missing photo recipes
from the current available admitted examples. Photo retrieval exposes missing
coverage in structured evidence and warnings, including partial availability.
Typographic retrieval and asset ranking remain unchanged. New recipes remain in
the geometry catalogue; absent human/reference/native admission stays open.
No example or approval is synthesized, and a warning is not admission evidence.

Run the existing mandatory-flag corruption/refusal drill during manifest verification.
Store its output separately and fail immediately if it fails. Reuse that actual result
at evidence emission rather than running the drill twice. Verification was already
required before this change; this improves failure timing and diagnostic visibility.

## Verification

Actual fresh Desk build and existing budget test; original photo asset/provenance
checks; exact missing-five coverage and unavailable-reference controls; current
connected retrieval tests and a new exact sealed full gate. Original full failures
are retained. This decision does not qualify the five missing recipes or Canva.


## Qualified follow-up

Final seal 8222c9806949344b5490230c682c6c24484944a6 passes all8 stages,6427 tests/0 failed/67 skipped;658 typed roots and1594 blueprint checks. Existing bundle budgets and actual one logged stage6 corruption/refusal control pass. Original first full6424/2/67, focused28/1 and incorrect refusal diagnosis remain recorded. Final native/Canva/human/product admission is open; this candidate is not deployed. Evidence: plans/content-aware-design-2026-09-30/INTEGRATED_RELEASE_PROOF.json.
