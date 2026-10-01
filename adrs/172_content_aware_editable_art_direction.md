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

## W2 representation detail

The base field is an optional bounded linear gradient with approved palette stops,
shared by the SVG preview and a named native DrawingML shape in PPTX. It sits below
art/photos and never flattens factual copy, source photos or logos. Promote the already
pinned fflate package from test-only to runtime for bounded OOXML serialization;
no new package/version is introduced. Transfer plans retain field parameters and
background decisions; generic reconstruction must retain the same native field.
Validate stop order/colors at every adapter boundary and use a conservative
luminance envelope for declared contrast. Actual rendered ink checks still apply.
Native DrawingML structural proof does not qualify Canva's import/edit/reopen/export;
that existing gate remains open and must report any import loss honestly.

Resolve requester color before surface/type choices. A forbidden palette request
refuses instead of silently substituting. Compatible reference texture and actual
copy density constrain optional fields. Existing photographs remain unchanged;
background decisions recolor the recipe's matching ground/fade, never its photo.

## ADR180 integration

The current release36369a12 records the owner's office-style preference when no
explicit photo count/all instruction is present. Preserve that foundation: only
explicit requester coverage binds a recipe; every received image still gets its own
report, and omissions remain visible. Required images in items3–4 above mean those
explicitly bound inputs. Merge the measured logo-ground implementation and office
message fixes; use individual W1 regions for logo relocation rather than losing
separate people to the incoming aggregate helper. Further visibility calibration
and actual native admission remain necessary; a p95 changed-pixel statistic alone
cannot establish readability of most logo details.

## W3 source feature visibility

Compile a bounded local edge signature from the official transparent logo raster at
its actual placed size. Check every meaningful connected artwork component against
the actual final composite. Components with internal color edges use those edges
(an approved opaque plate may legitimately disappear into the paper); flat components
use their alpha boundary. A high-contrast minority cannot certify absent lettering.
Compare feature contrast and direction with the source, not only pixels changed by
the current ground. Empty, oversized or unmeasured signatures refuse certification.
The initial 90% overall / 80% per-component bounds are an engineering screen requiring
archive/human calibration; they are not a universal accessibility or taste standard.

Measure existing panels and each thin fallback on their pixels. Try both approved
light/dark tones; if none passes, raise LOGO_UNREADABLE rather than mark a failed
fallback successful. Keep original bytes and clear-space/backing limits. Final QA
and edit QA recompute from the render and source signature, independent of the saved
logoGround record. Historical records remain readable but grant no new certification.
No model, provider call, asset alteration or new dependency is introduced.


## Owner clarification — ADR181

The owner's later 2026-09-30 direction makes the KAAE one-hero/navy-fade style a scoped
client preference. Retain ADR180's explicit-only coverage and conditional logo changes,
but remove its universal hero-only limit. Multiple meaningful images can be selected
without a count; an absent count does not force a collage. ADR181 records the amended
composition contract and the distinction between this engineering slice and full
W4–W6/human qualification.

## W4 topology extension and scoped tie-breaks

Add three native geometric alternatives: editorial_split (copy/image columns or stacked
portrait), photo_diptych (paired images for comparison), and photo_sequence (ordered,
source-aspect-weighted justified rows). Share bounded source selection/coverage across
multi-photo recipes. Enumerate a bounded contiguous row partition set for up to ten
photos; reject unreadable cells and infeasible protected-subject crops before ranking
local geometry. Preserve source order within the selected narrative; RTL changes reading
placement, never photo pixel orientation. With at least three eligible alternatives,
normalize three distinct recipe proposals and retain visible replacement evidence.

Subject tags alone may no longer activate a universal office recipe preference.
A deterministic style tie-break requires current-client, policy-identified reference
recipes with actual loaded-source evidence; absent/mismatched evidence abstains from
style preference. Sharpness evidence remains separate. This is the initial hard/soft
preference boundary, not learned taste or comparative admission. No new model call,
provider, generated image or dependency is needed for this extension.

## W3 native diagnostic environment — 1 October 2026

The original independent export used substituted fonts and PDF JPEG/reduction settings. Preserve that failed evidence. A separate reproducible diagnostic pins the existing font inventory, disables reduction, selects lossless export and binds original PPTX hashes; it refuses malformed inventories or existing output directories. Report actual requested/native font-family presence without promoting it to glyph/ink/bidi/Canva fidelity. Six corrected offline controls contain the declared font families but all still fail the unchanged source-edge logo screen. Compression alone is therefore not a sufficient explanation or an admitted repair. No production gate, threshold or original asset changes. Evidence: plans/content-aware-design-2026-09-30/W3_NATIVE_DIAGNOSIS_2026-10-01.json.

## Renderer-bound source visibility — 1 October 2026

Native source evidence demonstrates that pixel-edge signatures depend on the renderer basis. The same immutable official picture/transform on native white/black matte references gives six intact passes and27 prescribed-damage refusals under unchanged thresholds; local-raster signatures on those native composites fail. Bind diagnostic references to renderer/export/font identity, original source/input/geometry and freshly captured PDF/PNG hashes. Missing/mismatched basis is unmeasured, not a readability verdict. Per-component minima still reject a missing small detail when total coverage is99.6566%. Source reference selection can differ between engines; retain actual feature populations and require archive/human detail-preservation calibration. This is scoped engineering evidence, not universal/Canva/human admission. Original failures are preserved. See W3_NATIVE_RENDERER_BASIS_PROOF.json.
