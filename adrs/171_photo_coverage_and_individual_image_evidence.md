# ADR-171: Requester photo coverage and individual image evidence

Date: 2026-09-30. Status: accepted for implementation; release qualification pending.

## Context

The owner asks that every supplied image be read and reported independently and that required photographs be composed purposefully. Review of ADR-170 found that a recipe could waive the default all-photo contract without requester permission, and a missing image classification was silently replaced with `unrelated`. Both mechanisms could hide lost inputs. FR-041 and docs/11 require task fulfillment and source integrity; FR-022 and docs/08 keep references separate from required content. FR-057 qualification remains pending.

## Decision

- Only the deterministic requester selection authorizes omission. `all` (including no selection) means every content photo; `choose` preserves its recorded minimum. Recipe metadata and model text grant no authority to discard inputs.
- Validate a bijection between received image indexes and brief image reports. Missing, repeated, invalid or out-of-range entries fail visibly. Never invent an analysis. One vision call can report each image independently; six images do not require six calls.
- Retain each image report in the existing brief and expose each separately in requester notes, with its classification and actual placement or omission. Reports are model judgments, not source facts or approval. Historical runs with no report stay explicitly unreported.
- Add `hero_storyboard`, a bounded composition for multiple required photos: one dominant hero and a supporting sequence, plus measured live copy on a solid brand surface. The solver owns geometry, sizes, focus, count and feasibility. No mirrored/recoloured photos, invented photos, flattened factual copy or extra model call. A request that cannot fit remains a visible hold, never silently drops images.
- Pass the immutable recorded selection into generation and solving as well as QA. Existing single-hero recipes remain eligible when they can satisfy the minimum. A fallback must satisfy the same photo policy.
- V3 remains the existing pinned pilot path. This repair does not silently promote all Office requests to an unqualified pipeline; production routing and native/pilot evidence are recorded honestly.

## Verification

Test default six/all six/explicit choose counts; malicious or invalid model indexes; duplicate/missing image reports; bounded requester output; format and RTL geometry; rendered pixels; measured copy and contrast; native photo/text transfer. Retain failures and unexecuted live/native/200-case evidence in plans/reliability-2026-09-30.

## Consequences

The model has less authority, all-photo requests have a compatible composition, and omitted analyses become repairable failures. A closed recipe is an engineering baseline, not proof of superior creative quality. Blind human comparisons and actual Canva inspection remain required for those claims.

## Addendum: latest Claude live-trial integration (2026-09-30)

Integrate sealed Claude source `6af16cb8` including face/quiet-region checks, measured hero enlargement, native logo carriers, typography and deterministic house fallback. Its single-photo controls must explicitly grant a one-photo minimum; this does not weaken the six-photo default.

Before changing selection behavior: a `choose` minimum is a lower bound, so a storyboard may use two photos even when the requester permits one; it must never create a one-photo storyboard that the recipe itself forbids. A style prior is a fallback policy, not evidence the judge was reliable. Preserve a visible human-choice recommendation whenever the incumbent judge ties or fails its canary, including when the prior supplies the default. Missing enlargement measurements are unknown and cannot win a sharpness comparison or be described as 1x. Qualify these repairs without additional model calls.
