# ADR220 — Per-block imported font authority

Date: 2026-10-01. Status: locally implemented and qualified on bc25c8ca; production/product admission remains open.
Requirements: FR-028, FR-034, FR-035, FR-038, NFR-014, NFR-024.
Sources: docs/05_CREATIVE_ENGINE.md, docs/11_QA_RTL_MULTILINGUAL.md,
docs/30_CURRENT_STUDIO_CONTRACT.md, MASTER_SPEC.md, ADR208, ADR209.

## Observed failure and reason

The current full ordinary synthetic durable run on90c87686 holds the Kurdish
R1.BL design as CANVA_FONT_MISMATCH. Both blocks were actually imported in
Noto Sans Arabic; the immutable plan records that same face and the fake Canva
returns unchanged source bytes. The current Core helper excludes every source
with a reference pack from per-block checking. Its single-font fallback therefore
requires Verdana for Latin fragments inside the Kurdish blocks. Exact copy passes.
The model/reference does not establish font preservation; retained source and
captured byte/hash evidence establish this false refusal in the synthetic case.

## Decision

Use the complete immutable per-block font plan for both Studio and planner imports.
Validate one uniquely indexed block per exact-copy item, with an explicit nonblank
font family. A declared incomplete/ambiguous plan cannot silently inherit the
single-font fallback. Sources without a declared plan retain the historical
explicit reference font/script policy. Source actors, scopes, binding revisions,
current client/reference admission and capture-byte checks remain authoritative.

Freeze these indexed fonts into each newly admitted export operation; all existing
operation policies and previously rejected artifacts remain immutable. A fresh
capture must provide new evidence before a held design can advance. Preserve
current per-script actual-face checking, substitution refusals, exact copy and RTL
checks, and unknown glyph/visual/native results. Do not change client font policy,
weaken font-name matching, manufacture human labels, regenerate artwork or introduce
a provider/dependency. No production or native write is authorized by this ADR.

## Qualification required

Retain the original full-suite result, source/export bytes and source/checking
policies. An actual-byte regression must reproduce the intact mixed-script false
refusal before the repair and pass after it. Positive varied-font source evidence,
substitution/wrong-script-face/missing-family/duplicate-index/incomplete-plan
negative controls, historical reference-only policy, immutable replay and actual
Core/PostgreSQL capture are required. Rerun current bilingual delivery through the
real isolated Core/worker/Restate stack, relevant connected acceptance and the exact
engineering gate. Keep other original full-suite failures and unselected rollback,
production-dump, genuine native/human/product admission scopes explicit.

## Current qualification — 2026-10-01

Exact clean bc25c8ca passes 6,949 source tests (0 failures, 67 skips), 699 strict
roots, seven technical gate stages, mandatory flag refusal, and 54/54 ordinary
Docker durable scenarios (779/779 controls; zero uncovered model calls).
The same candidate also passes 202/202 deployed source/recovery controls
with real nginx, Desk, Core, worker and offline Docling, including both encrypted
fresh-volume co-restores. External adapters and staff actions are synthetic.
Original red/failed/cancelled receipts remain retained. Native/human/model/pilot
admission, offsite/PITR/RPO/RTO and authorized production-dump checks remain open.
No production deployment, native save or real provider call.
See plans/content-aware-design-2026-09-30/W6_DURABILITY_REPAIR_PROOF.json.
