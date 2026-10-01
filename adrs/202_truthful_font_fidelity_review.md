# ADR202 — Preserve font fidelity truth through render and review

Date: 2026-10-01. Status: accepted; exact engineering qualified, deployment/product admission open.
Requirements: FR-038, FR-041, NFR-012, NFR-024.
Sources: docs/05_CREATIVE_ENGINE.md, docs/11_QA_RTL_MULTILINGUAL.md;
ADR157/201; W5_FONT_FIDELITY_REPORT_FINDING.json.

## Evidence

The actual probe reports an unmeasured Amiri face under a temporary failing
renderer. `probeFontFidelity` converts every non-stand-in verdict to exact; the
manifest and review path therefore report exact and no warning. This exported
chain diagnostic does not establish a live outage or whole shipping admission.

## Decision

Preserve all four measured verdicts: exact, stand-in, uncovered and unmeasured.
Share one exported verdict type across render results and QA context. Retain the
existing stand-in warning; add explicit uncovered/unmeasured review warnings,
including a missing family in a supplied manifest. An absent manifest at a
preliminary geometry boundary is not invented rendering evidence.

Probe every distinct requested layout family, including names outside the fixed
default report list. Render reports contain the families actually used, avoiding
unrelated probes. Keep the public default full-family report for callers that
request it. Honor its explicit font directory rather than ignoring that input.

Warnings remain advisory under ADR157; this does not add a new gate, fabricate
approval or weaken actual glyph/copy/measurement/contrast checks. Exact copy,
client scope, palette, geometry, source editability and model/repair budgets stay
unchanged. Persist and display the warning through existing QA findings and
office notes, and add a plain-language font notice to requester draft notes,
without a new table or UI flow. The actual connected QA/DB/HTTP test reproduced
the requester omission after the saved office findings already passed.

## Qualification

Exercise actual probe-to-manifest-to-render-to-review results with a temporary
renderer that draws real pixels but refuses identity, actual uncovered font
bytes, missing manifest entries and exact/stand-in controls. Verify used-family
report scope, live copy, saved Core QA/HTTP evidence and Desk warning display;
retain original failures and strict/connected/exact engineering results.
Local font identity/ink samples do not establish all-copy shaping, native Canva
fidelity, human design quality or broader product admission.

Exact sealed ef76a307584e08502e0ae1af590b346f5d9afe8f: all8 engineering stages,6592pass/0fail/67skip,
676 strict roots and newest production dump/negative refusal pass.
See W5_FONT_FIDELITY_REVIEW_PROOF.json and its exact gate evidence.
