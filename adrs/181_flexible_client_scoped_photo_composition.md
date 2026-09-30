# ADR-181 — Content chooses composition; client references remain scoped

Date: 2026-09-30
Status: accepted; first source-selection engineering slice implemented; qualification pending; not deployed
Requirements: FR-022, FR-025, FR-026, FR-038, FR-041, FR-057.
Amends ADR-180 §1; retains its explicit-only photo obligations, omission reporting,
conditional byte-preserving logo treatment and office caption/title fixes.

## Owner direction

The owner clarified that every client and kind of design needs flexible content-aware
composition. One hero plus a navy fade is a KAAE reference preference, not a global
rule. Multi-photo compositions are allowed when they serve the content. No default
collage, half-of-uploads obligation or universal single-hero limit is authorized.
Source: owner message in Codex, 2026-09-30; Claude's additions document is research
input, whose earlier hero-only statement is superseded by this explicit clarification.

## Decision

Separate minimum coverage from composition capacity. Without an explicit all/count,
a candidate may use one or several relevant photos. Available multi-photo recipes
are eligible even when the required minimum is one. The model selects a bounded,
ordered list of source photo indices for supporting roles in its existing layout call;
the deterministic solver validates, deduplicates and completes only explicit coverage
obligations. Legacy/missing lists use one ranked support, never all uploads by default.
Every omitted photo remains visible review evidence; per-image reports stay intact.
No extra model call is added. Coordinates, crops, exact copy, source bytes, palette
and independent subject/coverage QA stay under deterministic constraints.

Client references are scoped style guidance. The global prompt must support diverse
content and clients and must not mandate navy, gold, a fade or one hero as universal
style. Joint background/composition planning precedes local geometry and contrast QA.
Learned taste later ranks admissible concepts from genuine approvals/corrections;
it cannot override explicit counts, factual copy or source protection.

## Integration and qualification

This first slice enables ordered native support subsets in the existing storyboard;
it does not qualify that recipe as professionally superior or complete W4–W6.
Additional geometrically distinct compositions, image-derived color policies, native
Canva typography and genuine held-out taste evaluation remain in PLAN.md.
Claude's proposed gaze/horizon, repetition, optical/grid and resolution metrics need
measured evidence and calibrated bounds before becoming hard gates. In particular:
exact-palette validation must be amended explicitly before allowing tints; highly
opaque scrims can obscure lower background fields; treatments must be evaluated in
the actual exposed part of the rendered composition. Preserve original logo pixels.
