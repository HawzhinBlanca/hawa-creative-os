# ADR212 — Candidate-local background infeasibility

Date: 2026-10-01. Status: connected and seven-stage engineering verified; production-dump and product admission pending.
Requirements: FR-028, FR-031, FR-038, FR-040, FR-041, NFR-012.
Sources: docs/05_CREATIVE_ENGINE.md, docs/11_QA_RTL_MULTILINGUAL.md,
MASTER_SPEC; ADR170, ADR181 and ADR206.

## Evidence and reason

An actual 800×1000 two-photo mosaic with an approved gray gradient and exact
three-line body copy has no approved readable ink. ADR206 correctly refuses it
without mutating the layout. However, its generic Error escapes the recipe
solver, aborting solveConcepts and generateArtDirectedCandidatesV3 before other
viable concepts can be considered. Four pre-fix regressions fail through those
actual functions; two policy/atomic-refusal controls already pass. This is a
local synthetic reproduction, not evidence of a particular live failure.

## Decision

Give only the exhausted valid background/ink search a typed
BackgroundInfeasibleError, retaining the exact diagnostic and copy index. At
the recipe solver boundary, classify it as RecipeInfeasibleError. The existing
bounded concept search then records the rejected recipe and original reason,
tries eligible alternatives and keeps viable independently editable candidates.
The existing Core layout-stage replacement warning remains authoritative.

Invalid palette, requester color, search bounds, schema and unexpected failures
are not converted into candidate rejections. Do not flatten the rejected field,
change its copy or approved colors, waive contrast, add another provider call,
increase the candidate count or automatic repair budget. The standalone planner
still refuses atomically. Fewer than two solved concepts still fails the existing
generation contract with the retained reasons.

## Qualification

Test actual solver classification, viable alternatives, deterministic replay,
single model-call billing/proposal correspondence, invalid requester refusal,
standalone atomicity, rendered-pixel contrast and native live-copy/source-photo
transfer. Run connected background/composition/render/Core paths, strict types
and lint. Exact release, real Canva, human quality and production deployment
remain separate admission gates; no global perfection claim follows from these
local engineering controls.

Connected qualification: 14 files/274 passed/0 failed/0 skipped; 689 strict test
roots, build and lint pass. The actual Core proposal/preparation path retains
viable concepts and warns with the original refused-background reason. The
initial four failures and first raster-fixture failure are preserved in
W2_CANDIDATE_BACKGROUND_REFUSAL_PROOF.json. No deployment or paid provider call.

Exact clean seal82857284 passes seven engineering stages,6823pass/0fail/67skip
across682 passed files/6 skipped,689 strict roots and1750 package checks. Mandatory
negative-flag refusal passes. Raw Stage3 is skipped; production-dump transfer
authorization remains pending after automatic approval review rejection. No
all-eight/product admission or deployment claim. The all-infeasible proposal
probe also refuses with original reasons and one synthetic call.
W2_CANDIDATE_BACKGROUND_REFUSAL_GATE_EVIDENCE.json retains actual receipts.
