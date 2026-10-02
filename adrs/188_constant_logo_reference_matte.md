# ADR-188: Build a constant logo reference matte locally

Date: 2026-10-01
Status: accepted; native helper equivalence/connected source pass, full qualification pending
Requirements: FR-038, NFR-014, NFR-018
Sources: docs/05_CREATIVE_ENGINE.md; MASTER_SPEC.md; ADR172 W5

## Evidence and decision

`nativeLogoContrast` launches the same native rasterizer twice: once for the
official logo on white, once for a full-viewport white rectangle. The second
job contains no source artwork, fonts, effects or content. Replace only that
constant comparison matte with opaque white RGBA pixels at the dimensions of
the actual native logo result. Continue rasterizing the official artwork with
the existing pinned backend; preserve the source bytes, positions, contrast
calculation, visibility thresholds and independent final-pixel QA.

Verify equivalence against the original two-render measurement using actual
native pixels, including transparency and fractional positions. Count real
rasterizer executions through a delegating test spy: one instead of two. Keep
bounded timing evidence separate from pipeline p95 or creative quality claims.
This is one W5 optimization; perceptual color policy, local refinement, replay
identity and broader cost/calibration qualification remain open. No cache,
provider call, model, dependency or altered logo source is introduced.

Verification: three real native work-count regressions fail against the old helper and pass after the change;50 focused cases and658 strict test roots pass. Nine paired native controls preserve contrast and source bytes. First measured medians78.1ms/74.7ms are a small helper sample only. See W5_NATIVE_MATTE_PROOF.json and W5_NATIVE_MATTE_BENCHMARK.json.
