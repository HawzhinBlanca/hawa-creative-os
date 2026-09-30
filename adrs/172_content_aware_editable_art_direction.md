# ADR-172: Content-aware editable art direction

Date: 2026-09-30. Status: accepted for implementation; qualification pending.

## Context and authority

The owner requested implementation of all six recommendations in
`output/research/2026-09-30-content-aware-design/REPORT.md` after reporting weak output,
repetitive backgrounds and boxed logos. Inspected baseline is deployed38f84442.
Relevant requirements: FR-034 (script/font fidelity), FR-041 (actual review evidence),
FR-057 (role qualification), FR-022 (scoped references) and FR-038 (source/layout validation).
Normative sources: docs/05, docs/08, docs/11 and docs/30; MASTER_SPEC invariants stand.

## Decision

1. Preserve individual source face/subject regions across service parsing, saved stage
   evidence, crop selection, candidate solving and QA. Use already measured face boxes
   before introducing another segmentation model. Invalid evidence is explicit;
   legacy aggregate-only evidence remains labelled unknown.
2. Plan background and composition jointly using bounded typed intent, palette,
   quiet/focal regions, source geometry, requested style and actual text density.
   Resolve explicit instructions before solving. Keep generated production assets
   separate from private visual references; reference pixels never ship.
3. Use verified official logo bytes/approved variants. Search suitable regions and
   preserve clearance; add a carrier only when measured visibility or brand policy
   requires it. Never delete white pixels or generatively redraw the logo.
4. Separate immutable photo coverage from composition. Offer several meaningful
   native topologies, narrative order and aspect-aware supports. Fail visibly when
   requested assets/copy cannot fit. Never omit required photographs or invent a
   different requested format.
5. Add deterministic brand-constrained image-color decisions and bounded local
   geometry/type refinement. Preserve intentional overlap/asymmetry, immutable copy
   and separate editable layers. Cache by input/crop/policy/model identity.
6. Separate hard brand obligations from example preferences. Calibrate visual
   selection against genuine office comparisons, retain order-bias/canary controls,
   abstention and human choice. An untrained or insufficiently supported preference
   model grants no authority or automatic promotion.

## Execution and cost

Reuse the existing durable workflow, model adapters and recorded calls. No agent
framework or generic automation layer. Prune/render local candidates before paid
critique; keep existing repair/call bounds and side-effect reconciliation. Heavy
research models remain optional experiments subject to measured host/license/fidelity
need; implementing these recommendations does not mean installing every paper.

## Proof and limitations

Track each vertical slice in plans/content-aware-design-2026-09-30/PLAN.md. Required
checks include malformed region data, crop/occlusion of every source region, explicit
background preservation, logo alpha/native identity, multi-photo topology diversity,
copy/RTL/font/contrast, render/native transfer, replay and calibrated-judge abstention.
Run engineering/recovery gates on the final sealed release before deployment.
Real Canva and human preference evidence cannot be fabricated. The proposed30-brief
diagnostic and200-case study require permitted material and authorized spend; a
superiority claim requires matched professional comparisons and confidence intervals.

This amends the rigid carrier/recipe behavior of ADR-170 and expands ADR-171 without
weakening requester coverage. Source-level engineering completion is distinct from
human quality qualification.
