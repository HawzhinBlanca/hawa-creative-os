# ADR199 — Shared spatial ink decisions through preparation and ranking

Date: 2026-10-01. Status: accepted for implementation; qualification pending.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md; ADR198; W5_COLOR_PREPARATION_FINDING.json.

## Evidence

Actual generic conformance and preparation replace readable black ink (4.511:1)
with white (4.442:1) on an unchanged gray gradient. Both reference title and accent
admission also compare a flat base. Advisory legibility and default layout metrics
can report readable contrast that disagrees with final QA. Eight initial regression
failures and one opaque-carrier control pass; retain original failures.

## Decision

Use the same declared spatial contrast authority in generic ink repair, reference
title/accent admission, background planning and advisory text/layout metrics.
Advisory legibility uses the already-authoritative hard-QA type-size thresholds
(32px regular or24px bold for large text), replacing its older20px/16px shortcut.
This aligns policy; it does not recalibrate aesthetic scores or weaken hard QA.

Build a per-decision contrast evaluator once per text footprint. It encloses the
current declared background/carrier once and evaluates multiple approved ink
colors against that fixed enclosure. It is a local computation, not a persistent
cache: recreate after geometry, field or carrier mutation. Keep the single-color
API compatible. This avoids repeating field traversal during palette sorting.

Preserve approved-palette scope, readable existing ink, exact copy, source assets,
editable backgrounds, geometry, font decisions and bounded model/repair calls.
If no approved ink reads, retain an explicitly failing candidate for existing QA;
do not invent a new color, remove the field or fabricate approval. A supplied
measured metric remains a supplied metric; final QA still recomputes actual
shipping evidence and measured pixels retain authority.

## Qualification

Exercise all four gradient directions through conformance, actual preparation,
JSON replay, real local raster contrast and editable transfer. Include unsafe
title/accent preferences, body-size policy, carrier precedence, measured overrides
and unsatisfiable palettes. Check connected solver/ranking/refinement/Core paths
and exact sealed engineering gates. Local computation timings are distinct from
pipeline latency, actual Canva/native round-trip and human design quality.

The normalized initial generator only constructs solid surfaces; its early color
proposal is not shipping contrast authority. Keep that proposal path separate from
these post-layout decisions. Broader W5/W6/native/human/product gates remain open.
