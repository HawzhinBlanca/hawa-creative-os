# ADR200 — Current policy and measured font identity before admission cache reuse

Date: 2026-10-01. Status: connected source engineering qualified; exact qualification pending.
Requirements: FR-028, FR-038, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md; ADR116/117/118/123;
W5_FONT_ADMISSION_CACHE_FINDING.json.

## Evidence and scope

A warmed `admittedFontFaces` returns a face after same-path policy revocation,
because its cache hit precedes registry reload. The existing Core input capture
invalidates caches at some boundaries; this does not establish a production outage.
Admission also depends on present declared weights and the actual regular file
whose glyphs are measured. Test these dependencies through actual exported
admission and family-selection functions using temporary files, without changing
production fonts or policy.

## Decision

Reload current registry policy before considering an admission cache hit. Bind
each cached result to the current declared-weight presence and actual measured
regular font content identity. Reuse the existing font loader's fingerprint,
content hash and parsed font cache; unchanged inputs retain the admission result
and avoid repeated glyph scans. Do not introduce an unconditional full font,
rasterizer or OS inventory on each palette/prompt query.

Missing, invalid or revoked policy cannot inherit a prior answer. Font removal,
replacement, corruption and restoration must produce the same result as a fresh
query under those inputs. Preserve rank/role/script/alias behavior, existing
weight-selection policy, exact copy, editability and shipping-pixel hard QA.
Fontkit admission is separate from raster fidelity: renderer/OS identity remains
part of existing capture and raster evidence, not glyph-only admission authority.

## Qualification

Retain original red regressions. Exercise same-process revocation, malformed and
deleted policy, same-path font replacement with restored mtime, missing and
corrupt files, restoration, stable-input hits, declared-weight removal and actual
family selection. Run connected font/render/preparation/transfer/QA tests and
strict types. Record exact source and broader engineering gates separately from
native Canva, visual quality, human approval and deployment.


Six original acceptance regressions fail on the prior source. Corrected connected11files86pass/0fail/0skip,672 strict test roots and lint pass. No new dependencies or provider calls. W5_FONT_ADMISSION_CACHE_PROOF.json retains red/green evidence; exact seal and product admission remain pending.
