# ADR-117 — Require text measurement evidence at Studio hard QA

Date: 2026-09-28. Status: accepted; local mandatory-measurement qualification,
mixed-font/native geometry still open.
Requirements: FR-015/037/038/039; `docs/08_MEMORY_RAG_CLIENT_DNA.md`,
`docs/05_CREATIVE_ENGINE.md`, `docs/11_QA_RTL_MULTILINGUAL.md` through
`plans/traceability.csv`; preserve the current Canva contract and workflow owner.

## Evidence and decision

At source 779bba0e a title needing 195px in a 100px box fails with complete copy
but the same layout passes when its copy is missing. Measurement helpers suppress
font errors; hard QA substitutes one line and zero width. Production normally
supplies the copy map, but the shared gate cannot use missing evidence as success.

Measure mandatory text in one structured pass. Every block yields measured geometry
or a named unmeasured reason. Missing/blank copy, invalid measurement inputs,
unavailable/corrupt fonts, missing visible glyphs and shaping failure refuse QA.
Only measured geometry can prove fit. Preserve exact input strings and bind results
to copy/font hashes. Retain the final measurement evidence in the existing run QA
snapshot. Existing pre-art and selection gates must reject these outcomes before
paid calls; no judge or deterministic fallback may promote them.

Optional aesthetic helpers retain their existing best-effort API. They are not
mandatory QA evidence. No new service, storage table, provider or dependency.
Do not cache a successful measurement across changed inputs. Existing font cache
identity remains in force; full renderer/runtime pinning is separate work.

## Alternatives and limits

Throwing alone would lose actionable per-block diagnostics. Default geometry hides
unknowns. Relaxing the gate for tests would preserve the defect. The selected
structured outcome allows safe refusal and precise repair without changing copy.

Local fontkit advance/wrap evidence is not native Canva clipping, bidi, ink-bound
or editability proof. Native export and human review remain required. Blank required
blocks need correction upstream rather than a fabricated successful measurement.

Stored mixed-script layouts expose unmeasured fallback: Noto Sans Arabic lacks
some Latin letters and punctuation which the rasterizer can draw from another
font. A primary-face width is insufficient to certify these blocks. They now
remain refused without changing the requested type style. Qualifying mixed-font
shaping and wrapping is required before broad rollout; this slice does not declare
those designs defective in Canva or claim the entire multilingual path is complete.

Connected service inspection also reproduced final QA retaining the former winner's
failure after selecting a valid replacement. Save the replacement's measurements
with its candidate ID, preserve the former result separately, and honor the same
operator selection hold on both paths.

## Acceptance

Reproduce the missing-copy false pass before the fix. Test real temporary missing,
corrupt, replaced and restored fonts, multilingual visible coverage, mixed/control
text, nonfinite geometry, vertical/horizontal overflow and unchanged source copy.
Prove production pre-art zero spend, ineligible selection and failed final QA for
unmeasurable content, alongside valid progress. Check retained evidence and affected
render, typography and service regressions. Record executed and unexecuted gates.

## Local qualification

Four false-pass cases fail on the former implementation. Connected qualification
passes 208 tests in 16 files, then 48 tests in four boundary files after extending
artwork admission to both pipelines. Real isolated-DB final QA persists hashes;
replacement-winner and selection-hold checks pass. All 528 strict test roots and
source/scripts types pass. No paid/native execution or deployment. See
`plans/lean-design-implementation-2026-09-28/TEXT_MEASUREMENT_PROOF.json`.
