# ADR-187: Final QA measures the shipping layout

Date: 2026-10-01
Status: accepted; exact sealed engineering pass, deployment/product admission pending
Requirements: FR-038, FR-041
Sources: docs/05_CREATIVE_ENGINE.md; docs/11_QA_RTL_MULTILINGUAL.md; docs/30_CURRENT_STUDIO_CONTRACT.md

## Context

Final hard QA accepts a caller's cached LayoutMetrics when validation does not
normalize the layout. Candidate geometry and copy can change after those metrics
were produced. A stale alignment/overlap score can therefore authorize the wrong
layout, while a stale failure can reject a sound layout. Metrics computed from the
validator's normalized copy also describe a layout QA deliberately does not ship.
The connected regression formerly fabricated a low score on an aligned layout,
testing trust in the cache rather than detecting an actual geometry defect.

## Decision

Recompute deterministic geometry from the original shipping layout on every final
QA invocation. Keep the optional cache argument for caller compatibility, but do
not authorize or report from it. Measure current exact copy with the existing
pinned font path; use those line counts in the report. Use current declared
surface contrast unless the current composite supplies measured pixel contrast.
Preserve all thresholds, exact copy, original layout and existing unmeasured-copy
refusals. No new provider call, dependency, model or workflow is introduced.

## Evidence and limits

Connected Core QA controls must exercise genuine off-grid geometry with forged
passing metrics, aligned geometry with stale failing metrics, and changed copy
and contrast with stale reports. Focused/full sealed qualification is pending.
This repair does not qualify subjective composition quality or native Canva.

Focused proof: three red cases and one existing pass; rebuilt connected seven-file suite107 passed/0 failed/0 skipped. The first green attempt read stale dist and remains retained. See plans/final-qa-basis-2026-10-01/LOCAL_PROOF.json.

Exact sealed qualification056f236e (source d300591e): eight mandatory stages passed, full6305/0failed/67skipped,653 typed roots,1518 blueprint checks, latest production dump and lint pass. This QA repair is not deployed; live0605a713 remains verified.
