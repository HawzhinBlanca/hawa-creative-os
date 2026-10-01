# ADR213 — Preserve valid photo intent during normalization and hero repair

Date: 2026-10-01. Status: connected engineering verified; exact gate and product admission pending.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md, MASTER_SPEC; ADR170 and ADR181.

## Evidence and reason

Actual synthetic normalization of a diptych with hero0 and support[0,4] drops
the valid4 because it truncates to one support before excluding the hero. The
solver then selects1 instead. Actual same-recipe replacement of a blurry hero
reduces a feasible ordered four-photo mosaic/sequence/storyboard to two photos,
resets a feasible texture to a different source and loses title-accent words and
typicality. Direct solving with only the hero changed proves the intended
supports/treatment feasible. These are local reproductions, not claims of a
particular production incident or human quality score.

## Decision

Inspect no more than the model contract's nine support entries, then filter
invalid/hero indices and deduplicate in narrative order before applying the
recipe capacity. A bad prefix must not displace a valid declared support.

Same-recipe hero recovery changes the hero/cutout role and preserves valid
existing supports, noncolliding texture, exact title-accent words, typicality,
slots, background parameters and concept description. A promoted support is
removed from its former role; do not force the blurry previous hero or every
upload back into the design. Missing/conflicting texture
is cleared rather than inventing a new optional scene; explicit no-texture remains
no-texture. Explicit requester all/count coverage remains completed by the solver.
Oversized direct support input is left to the existing refusal without scanning
it. No invented photo IDs, global one-hero style, forced collage or extra call.

Other-recipe fallback remains a new default composition with its existing
recorded reasons. Hard geometry/crop/copy/contrast/schema/coverage checks, hero
resolution classes, candidate count and provider/automatic repair bounds remain
unchanged. The original source choice must not be mutated, and replay must be
deterministic.

## Required qualification

Retain pre-fix failures and corrected-fixture history. Test malformed prefixes,
deduplication and nine-entry bounds, all three multi-photo recipes, hero/support
collision, meaningful omissions, exact accent and texture preservation, explicit
all/count coverage, one-call generation, actual Core preparation and editable
source-photo bytes/live copy. Run connected composition/background/QA paths and
strict compilation/lint. Real Canva/native/human quality and the required
production-dump release check remain separate open gates.

Connected qualification:16files283pass/0fail/0skip;691 strict roots/build/lint
PASS. Actual Core retains three distinct four-photo plans through hero replacement,
with no extra call. Real local raster and editable-source selected/omitted hashes,
exact live factual copy and replay pass. Original/fixture/strict failures retained
in W4_PHOTO_INTENT_REPAIR_PROOF.json. Not deployed; native/human admission open.
