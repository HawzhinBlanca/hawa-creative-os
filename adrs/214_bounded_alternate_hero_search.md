# ADR214 — Search supplied alternate heroes before discarding a composition

Date: 2026-10-01. Status: connected and seven-stage engineering verified; production-dump/native/human/product admission pending.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md, MASTER_SPEC; ADR170, ADR181 and ADR213.

## Evidence and reason

An actual synthetic hero-card solve retains a 200px source at 4.84x enlargement,
although changing only the hero to another supplied 2400px source produces the
same feasible composition at 0.40x. Every existing fallback selects the highest
subject-fit photo again, so neither more recipes nor the existing one-default
hero repair can discover the viable source. This is local reproduced evidence,
not a claim about a particular live task or professional preference.

## Decision

Keep the original proposal first, then the existing recipe-specific default
hero, then other supplied sources in the current deterministic hero ranking.
Inspect at most ten distinct alternate sources per concept. Cutout recipes may
use only sources with existing admitted cutout evidence. Each alternate passes
the unchanged actual solver, crop/subject, coverage, schema, contrast and
resolution checks; a failed source retains its ordinary refusal reason.

Preserve ADR213's selected support narrative, exact title-accent words, slots,
background parameters, typicality and concept description. Remove only a
promoted support or conflicting optional texture. Never invent a texture,
mirror/recolor an image, force unspecified uploads, or mutate the original.
Explicit requester all/count coverage remains the solver's obligation.

Only after this bounded same-composition search may existing other-recipe
fallbacks run. A feasible original returns immediately. If no sharp replacement
is feasible, retain the existing warned soft fallback; invalid requester policy
and unexpected errors still abort. This is local feasibility search inside the
existing composition step, not additional model or automatic repair rounds.
No new provider call, dependency, score, recipe or learned preference.

## Required qualification

Retain failing regressions for low-resolution top-ranked sources and protected
crop failures with a valid lower-ranked source. Verify content order, texture
collision, explicit count/all obligations, cutout eligibility, original fast
path, finite search, soft fallback, invalid-policy refusal, deterministic replay,
one billed call and actual Core preparation. Validate local raster contrast and
editable source/photo identity. Connected tests, strict types, build and lint are
required. Full release, real Canva/native/human/taste and product admission remain
separate gates; no production deployment is implied.

Connected evidence:18files275pass/0fail/0skip;693 strict roots/build/lint PASS.
Actual Core, local raster/editable exact copy and selected source-byte transfer,
original fast path, refusal bounds and deterministic replay pass. Original and
introduced failures retained in W4_ALTERNATE_HERO_SEARCH_PROOF.json. Cutout
source eligibility is verified; its existing resolution policy is unchanged.
No production deploy or paid call; native/human/product admission remains open.

Exact clean seale3bf5306 passes seven engineering stages,6855pass/0fail/67skip
across686 passed files/6 skipped,693 strict roots and1762 package checks. Mandatory
negative-flag refusal passes. Raw production-dump Stage3 skipped; previous
automatic approval review requires explicit transfer authorization, still pending.
No all-eight, production deployment, native/human or product admission claim.
W4_ALTERNATE_HERO_SEARCH_GATE_EVIDENCE.json retains actual receipts.
