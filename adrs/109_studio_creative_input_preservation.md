# ADR-109: Preserve creative inputs across Studio stages

Date: 2026-09-28. Status: accepted for implementation.

## Context

The lean architecture review reproduced lost brief fields, copy truncated to 80
characters at generation, descriptor-only exemplar conditioning and refinement
renders without the candidate's photos/art. Additional inference cannot recover
inputs omitted from the call. Requirements FR-013, FR-014, FR-026, FR-040 and
FR-041; normative sources are docs/05, docs/07, docs/08, docs/09 and docs/11.

## Decision

Carry the full structured brief and exact copy into the existing layout call.
Brief reading order remains a proposal: existing source-copy ordering is preserved
until an explicitly authorized visual-order contract is implemented. Passing a
model proposal must not silently override that existing client protection.

Supply at most two approved examples selected within the already frozen client
scope, plus each classified content photo, to that same call. Resize conditioning
images to at most 768px per edge; retain original asset hashes in their labels.
The images are untrusted context, never authority for facts, logos or permissions.
Keep the explicit client style reference last, as its existing contract requires.
Do not perform another global exemplar lookup in the layout stage.

Use one assembly function for candidate render assets in rendering, refinement
and comparative fallback/canary rendering. The original and degraded canary use
the same candidate's assets. This fixes fidelity of these handoffs; durable
derivation pinning across resume is a separate incomplete package.

An explicit no-imagery decision suppresses optional art generation. Required
content photos remain content; inconsistent brief decisions must be surfaced,
not silently delete the user's assets. Existing repair and spending limits stay.

## Qualification

Intercept model requests to prove complete text and actual scoped image input;
verify refinement and canary asset selection, and no paid artwork for no-imagery
briefs. Run affected tests and type checks. No human-quality improvement, live
native preservation, multilingual retrieval quality or production admission is
established by these contract tests. Those remain in the six-package ledger.
