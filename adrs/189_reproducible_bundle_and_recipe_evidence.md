# ADR-189: Reproducible bundle and explicit recipe evidence

Date: 2026-10-01
Status: proposed; first combined full gate failed two checks
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

The ordinary gate also marked its negative refusal test as verified without running
the existing corruption drill in that invocation. A historical result is insufficient
evidence for a new candidate.

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
Store its output separately and fail qualification if the drill fails; only then may
the resulting gate evidence mark that check as verified.

## Verification

Actual fresh Desk build and existing budget test; original photo asset/provenance
checks; exact missing-five coverage and unavailable-reference controls; current
connected retrieval tests and a new exact sealed full gate. Original full failures
are retained. This decision does not qualify the five missing recipes or Canva.
