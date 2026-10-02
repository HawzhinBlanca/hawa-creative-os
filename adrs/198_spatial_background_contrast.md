# ADR198 — Spatial conservative contrast for editable background fields

Date: 2026-10-01. Status: source engineering qualified; product admission open.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md; ADR172; owner content-aware direction (2026-09-30).
Technical source: https://www.w3.org/TR/SVG/pservers.html (accessed 2026-10-01).

## Evidence and decision

The existing declared contrast uses a channel envelope across the entire canvas
gradient. Four directional controls and a multi-stop control return 1:1 for white
ink on a dark local region; final QA rejects that region despite the actual local
render. Initial regression: six failures, four controls pass. Retain the red log.

Project each text footprint onto the field's declared axis. Include a one-pixel
edge guard and every overlapping stop interval. For each interval, bound the RGB
channels in 32 subintervals and take the union of their luminance envelopes. This
is a conservative enclosure, not a sparse sample: per-channel linear interpolation
stays between subinterval endpoints and luminance is monotone in each channel.
Include a one-channel-value guard for local 8-bit quantization. Work is bounded to
96 subintervals for the schema's four stops, with no provider calls or dependencies.

Missing, invalid or out-of-canvas footprints fail closed to the full luminance
range. Preserve the existing carrier precedence, palette admission, copy, geometry,
gradient serialization and contrast thresholds. Interior stops and interior
luminance crossings remain failures. Measured rendered-pixel QA remains mandatory
where supplied; a declared surface never authorizes different shipping pixels.

## Scope and qualification

This amends ADR172's whole-field declared envelope, allowing readable regional
composition without adding a plaque or silently changing ink. It does not infer
photo contrast, authorize new palette colors, calibrate taste, qualify Canva, or
assert professional superiority. Existing hard gates and human approval remain.

Qualify four directions against the actual local renderer, adversarial multi-stop
and crossing controls, final QA measured-pixel refusal, exact palette, transfer and
replay preservation. Record bounded local cost separately from pipeline latency.
Run the exact sealed engineering release gate before deployment.

## Related carrier enclosure

The same footprint audit found that nine fixed opacity samples miss narrow
transparent valleys. Radial carriers inspected only the farthest corner, missing
interior rings. Reproduce four linear directions and a radial ring, then evaluate
the exact piecewise-linear minimum at the footprint endpoints and all contained
stops. Radial distance spans from the nearest point of the rectangle to the
farthest corner. Work is bounded by the existing eight-stop schema, with no
additional raster or provider calls. Preserve the carrier threshold and precedence.

The first radial control ended before the ring and incorrectly expected zero;
retain that failure and correct the footprint to actually include the ring before
qualifying the repair. The corrected five regressions fail on the old algorithm.


Exact sealed 07ebe842a6ba4c903c5c314fe39ccb27403ddf29 passes all eight engineering stages: 6555 tests passed, zero failed, 67 skipped; 670 strict roots, 1658 blueprint checks, newest production dump restored in isolation and negative-flag refusal. See W5_SPATIAL_BACKGROUND_PROOF.json and W5_SPATIAL_BACKGROUND_GATE_EVIDENCE.json. Source only, not deployed; native Canva/human/product admission remains open.

The next independent diagnostic reproduces flat-surface ink repair in generic preparation: regional black ink4.511:1 becomes white4.442:1 under the unchanged4.5 body threshold. Both direct conformance and actual preparation reproduce it. W5_COLOR_PREPARATION_FINDING.json is source evidence, not an acceptance-test result; its regression and repair are pending.
