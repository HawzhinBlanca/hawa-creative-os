# ADR206 — Joint approved background feasibility and atomic refusal

Date: 2026-10-01. Status: connected source qualified; exact engineering gate pending.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/11_QA_RTL_MULTILINGUAL.md;
MASTER_SPEC invariants; ADR172/198/199; W2_BACKGROUND_FEASIBILITY_FINDING.json.

## Evidence

The exported planner chooses the nearest approved gradient stop before checking
copy. The existing #888888→#666666 field refuses a long body column, while the
approved #888888→#BBBBBB field fits the same boxes and unchanged ink thresholds.
The refused call already changed its caller's background and may change carriers,
ink, accents and procedural art before a later text block fails. This harms
fallback and deterministic replay even though no candidate was accepted.

## Decision and reason

Resolve the base surface, requester plateau, direction, density, scene and texture
precedence exactly as before. Enumerate the existing approved, perceptually close
stops in ascending CIEDE2000 distance, with palette order breaking ties. Evaluate
the complete spatial ink feasibility of each field before selecting the first
feasible one. Keep an already-readable role ink; otherwise choose the highest
contrast approved ink using one local enclosure per block and field.

Stage recoloring of matching ground carriers and overlays without touching the
caller. Record ink/accent changes locally. Apply all changes to the existing root
and node objects only after every block passes; refusal preserves input values
and object identities. No field flattening, invented color, extra plaque,
geometry repair or provider call is permitted to make the test pass. If all
eligible fields fail, refuse visibly rather than silently changing a requested
gradient into a solid surface. Existing no-neighbor, scene and density decisions
still produce their existing solid/scene mode.

The local search accepts at most32 palette entries and the layout contract's40
text blocks,40 shapes and6 overlays; oversized input refuses before contrast
trials or mutation. One stop search replaces repeated provider repair; it is not
another automatic design repair round. Cache CIEDE2000 distances once and scan
approved inks once per failing block, instead of sorting with repeated contrast
calls. Preserve exact copy/source assets/fonts/geometry, hard thresholds,
requester color and compatible reference texture.

## Required qualification

Retain original failed regressions, including any corrected test-fixture mistake.
Verify nearest-feasible stability, an alternate field, requester plateau,
unsatisfiable/invalid/oversized atomic refusal, success node identities, JSON
replay, actual preparation, full-scene and no-texture precedence. Check local
raster contrast and separate editable gradient/live-copy transfer, then connected
solver/preparation/refinement/Core paths and the exact source engineering gate.
Native Canva/render/export preservation, actual professional quality and human
acceptance remain separate open gates. Do not claim product completion from local
fixtures or engineering tests.
