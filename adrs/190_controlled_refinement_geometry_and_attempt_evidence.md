# ADR190 — Controlled refinement geometry and complete attempt evidence

Date: 2026-10-01
Status: exact source engineering qualified; native/human/product admission open
Requirements: FR-034, FR-038, FR-041, NFR-014
Sources: MASTER_SPEC.md sections2/6; docs/05_CREATIVE_ENGINE.md;
docs/08_MEMORY_RAG_CLIENT_DNA.md; docs/11_QA_RTL_MULTILINGUAL.md; ADR172 W5.

## Observed boundary

The precision repair schema returns a reduced complete layout. Its response cannot
represent background fields/decisions, text accents or richer shape/photo metadata.
Replacing the original with that response discards those layers. A prompt saying
not to change colors cannot enforce immutable client inputs. Rejected photo-covering
and malformed responses also exit before the round's call receipts reach the result.
Core's durable call ledger is separate; missing refinement evidence does not prove
unrecorded spending there.

## Decision

Treat the existing response as a geometry proposal against the current layout.
Validate bounded finite geometry and exact element identities before applying it.
Canvas, grid, colors, fonts, roles, direction and emphasis remain protected. Preserve
all original editable layers and optional fields by cloning the original and applying
only approved box and type-size geometry. Reject changed/deleted/duplicated copy
identities and changed structural/style inputs with explicit findings.
The authoritative live-copy map outranks an incomplete generated layout: a repair
may restore missing requested blocks, with fonts/colors from the current design or
explicit trusted client policy. It may never invent an unknown copyIndex. Restored
blocks retain live copy and must pass the existing prepared final QA before adoption.

The first connected run122 passed/2 failed. One mock silently changed fonts/colors
and added shapes; retain it as an explicit rejection control and use a genuine
geometry-only mock for the geometry adoption case. The other uncovered a real
missing-copy restoration requirement; this authority exception implements it rather
than changing that test or preserving the generator's incomplete result.

Every completed critique/repair attempt retains both actual call receipts, including
rejected proposals; no paid response silently disappears from refinement evidence.
Core saves its rejection alongside the round. Bound the existing engine to zero–two
rounds and validate options before calls. Zero disables it without spending. Existing
production final preparation, independent QA and strict adoption still apply.

This is a necessary foundation for local optimization, not completion of W5, aesthetic
calibration or Canva admission. No provider, dependency, threshold or photo rule changes.

## Required evidence

Retained reduced-response regression; malicious/malformed geometry and identity
controls; exact optional-layer/copy/style preservation; rejected-attempt receipt and
round bounds; connected pipeline/Core evidence; build/types and sealed release gate.
Native/human quality and broader local optimization remain open.


## Exact engineering qualification

Sealb3241f783b1736746db99a915e6d55fd19ddeaf0 passes all8 stages,6453 tests/0 failures/67 skips,659 typed roots and1602 blueprint checks; newest production dump invariants and actual refusal control pass. Original17-failure and122/2 connected runs retained.130 current connected tests and overlapping25 native structured-transfer controls pass; build/lint pass. Source is not deployed and real Canva/native/human/W5/W6/recovery admission remains open. Proof: plans/content-aware-design-2026-09-30/W5_REFINEMENT_BOUNDARY_PROOF.json.
