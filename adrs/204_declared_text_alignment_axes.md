# ADR204 — Measure declared text alignment axes

Date: 2026-10-01. Status: accepted; connected source qualified, exact gate pending.
Requirements: FR-038, FR-041, NFR-012, NFR-024.
Sources: docs/05_CREATIVE_ENGINE.md; docs/11_QA_RTL_MULTILINGUAL.md;
ADR172/203; actual Core type-scale QA diagnostic.

## Evidence

Actual Core QA rejects the recipe's left-aligned title/body at x=76 because the
intentional narrower body column has a different right edge. Its 0.667 score is
below the unchanged 0.70 threshold. The metric counts shared box centres even for
left-aligned text, but does not give the same credit to its actual left axis.
The failure is retained, not fixed by changing the fixture's style or the gate.

## Decision

For text, measure the axis its declared alignment uses: left edge, right edge or
centre. A grid-aligned or shared text axis supports the box, as the existing
centre rule does for centred composition. Unused box centres cannot certify
ragged left/right text. Keep physical grid/edge checks for remaining edges and
geometric centre alignment for shapes/logos; only genuinely centred text can
support their centre. Keep the existing threshold and 0.5%-width tolerance.

Apply the rule to geometry, not client/recipe names. Exact copy, fonts, source
assets, style, dimensions, containment, contrast, subject and overlap gates stay
unchanged. This is layout-consistency evidence, not calibrated human taste.

## Qualification

Retain red unequal-width flush left/right and false-centre controls, existing
centre behavior, six approved exemplars and deliberate off-grid controls. Check
the actual Core render/QA/transfer path that exposed the mismatch and the full
release gate. No provider, native Canva or human preference admission is implied.
