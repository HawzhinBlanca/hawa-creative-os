# ADR-110: Spend creative compute only on eligible candidates

Date: 2026-09-28. Status: accepted for implementation.

## Decision and reason

Before optional artwork, run the existing free source/geometry/copy/font checks.
Reject proven failures and retain their layouts and reasons. Contrast dependent
on unfinished imagery is deferred to the complete QA gate. A pre-art pass is not
final QA. When no candidate survives, stop with a specific diagnostic; do not
silently buy another layout or use the legacy fallback. Existing bounded repair
of candidates surviving this preflight remains unchanged (FR-040).

At comparison admission, only candidates with explicit passing hard QA are
eligible. Missing QA is unknown. One eligible candidate skips both pairwise and
canary calls. Zero eligible candidates stop without any judge call. A judge
transport failure may use the deterministic ranking only among eligible
candidates. Rejected candidates cannot become a fallback winner or runner-up.

This extends existing stages and evidence; it adds no framework, provider,
database or repair loop. Final native/export QA and human approval remain required.
Requirement mappings: FR-040 and FR-079, docs/11_QA_RTL_MULTILINGUAL.md and
docs/17_UI_UX.md; creative execution follows docs/05_CREATIVE_ENGINE.md.

## Qualification

Prove zero paid calls for zero/one eligible candidate and rejected artwork;
prove unavailable judge fallback cannot promote failed/unknown QA; retain
preflight reasons. Test mixed candidate sets, absent evidence and existing
comparison/canary behavior. Measure rejection/finishing rates in the later
equal-budget human study: lower spending alone is not a quality improvement.
