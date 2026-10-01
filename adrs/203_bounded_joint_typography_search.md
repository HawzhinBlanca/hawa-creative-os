# ADR203 — Bounded joint typography search

Date: 2026-10-01. Status: accepted; connected source qualified, exact gate pending.
Requirements: FR-038, FR-041, NFR-012, NFR-024.
Sources: docs/05_CREATIVE_ENGINE.md sections 1/9;
docs/11_QA_RTL_MULTILINGUAL.md sections 2/3;
ADR172; W5 local optimization in the content-aware design plan.

## Evidence

The actual recipe solver samples its type scale in four-percent factor steps.
A temporary finer-grid experiment, using actual font measurements and unchanged
source, fits a synthetic hero-fade title/body at 56/25px instead of 53/24px.
The existing joint text/photo constraints accept both. This establishes missed
usable sizing, not human aesthetic superiority or a production failure.
The current loop can also omit its declared minimum factor and repeats identical
integer sizes. The experiment is retained in the type-scale diagnostic dossier.

## Decision

Enumerate distinct integer type-scale states induced by the existing rounding,
minimum sizes, hierarchy and natural scale. Include the exact search endpoints
and rounding transitions. Try states in descending factor order; retain the
first actually measured state that satisfies the existing line limits and joint
geometry/subject constraints. Do not assume feasibility is monotone: wrapping,
photo row packing and protected crops can change at discrete transitions.

Keep the existing one-line preference and its 80% lower bound, then the existing
two/three-line policies. Keep every font, copy identity, palette, recipe, source
asset and explicit photo-count obligation. No new style, model call, repair cycle
or dependency. Deduplicate measured states by sizes actually used by the group.
Search is bounded before measurement: at most 1,024 rounding transitions and
512 distinct scales. Invalid or oversized searches refuse explicitly through
RecipeInfeasibleError; never pretend an exhausted search found a solution.

## Qualification

Reproduce the actual missed-size case before repair. Verify endpoint and dense
independent state coverage, descending order, unused-role deduplication and
resource refusals. Run all recipe/topology/direction/format constraints, actual
local rendering and editable transfer, and the Core QA path. Retain failures;
measure local cost separately from provider/pipeline latency. Native Canva,
human comparative quality and whole-product admission remain separate.
