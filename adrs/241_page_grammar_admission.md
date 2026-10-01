# ADR-241 — Validate optional client page grammar at reference admission

Date: 2026-10-02
Status: implemented; merged source qualified at dffe7a3a; latest-live reconciliation pending
Requirements: FR-017, FR-023, FR-038
Sources: docs/08_MEMORY_RAG_CLIENT_DNA.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/05_CREATIVE_ENGINE.md, plans/content-aware-design-2026-09-30/KAAE2025_INTEGRATION_REVIEW.md.

## Evidence and decision

The unfinished ADR238 parser accepted empty nested objects, empty gradient stops,
and a nonnumeric width share. Composition then threw or produced nonfinite geometry.
Introduce one pure typed admission function in creative, called by Core's packaged
reference resolver and the shared studio reference reader before model/composition work.
Missing grammar remains optional. A present malformed grammar must be refused with
`PAGE_GRAMMAR_INVALID` and a field path; Core maps it to HTTP422. Diagnostics must not
echo supplied values or arbitrary unknown property names.

The contract validates all nested members, actual types, finite geometry, palette
membership and bounded arrays. Gradients have two to eight strictly ascending stops
in [0,1], matching ADR238's native shape contract; inset endpoints are allowed.
Shares are bounded by the canvas, usable dimensions positive, margins below one half,
opacity [0,1], line height (0,5], letter spacing [-1,1] em, angle [-360,360] degrees,
and sunburst rays integer [1,64]. These are resource/geometry limits, not client style
choices. Metadata has explicit bounded source/rule fields. Unsupported fields fail
rather than being silently stripped. The original reference is never rewritten,
so its content hash, provenance, facts and chosen client remain unchanged.

This changes reference admission, not the selected editor, renderer, client palette,
font admission or workflow. It introduces no dependency or migration and does not
activate ADR238's unfinished renderer. Nonpackaged DNA schema evolution and the final
ADR238 parser integration require the completed branch and connected acceptance.
No KAAE style or photo-count rule is imposed on another client. Explicit requested
photo coverage and content-aware multi-photo composition remain authoritative.

## Acceptance

Reproduce the three missing refusals through actual current Core/shared reader code;
then require structured refusals, valid/no-grammar compatibility, unchanged reference
identity, palette isolation, bounded gradient/font/geometry controls and the existing
connected client-reference/composition suites. Preserve red receipts and record the
verification scope in traceability. Native/human/product admission is independent.

## Integration follow-up — completed ADR238 source, 2 October 2026

Claude committed the finalized guideline at4c95154a during this repair. Consolidate
its renderer parser onto this pure admission function. The merged grammar uses the
completed native contract: gradient stops span0..1 and angles are0..360. The earlier
inset/negative-angle acceptance in8ca1fa4a is historical focused evidence. A full-span
gradient can express the same inset effect by repeating the end colours; this
convention keeps the parser, native shapes and renderer consistent without choosing
a client style. Preserve typed metadata, original input hashes, explicit supplied-
invalid refusal, scoped client palette and content-aware multiple-photo safeguards.


## Identifier reconciliation — 2 October 2026

Originally published as research ADR239 in8ca1fa4a/8e813a0e. Current production
1e0616f0 carries the separately lead-assigned ADR239 for consent-preserving DNA saves
and double-role replies. This admission decision is now ADR241; both histories remain
valid for their dated sources. No runtime contract change follows from renumbering.
