# ADR208 — Script-specific captured PPTX font evidence

Date: 2026-10-01. Status: source engineering qualified; native/human/product admission open.
Requirements: FR-028, FR-034, FR-038, FR-041, NFR-012, NFR-024.
Sources: MASTER_SPEC.md; docs/05_CREATIVE_ENGINE.md;
docs/07_MODEL_REGISTRY_AND_EVALUATION.md; docs/11_QA_RTL_MULTILINGUAL.md;
docs/30_CURRENT_STUDIO_CONTRACT.md; actual checker regressions, 2026-10-01.

The captured checker accepts generated Sorani text when its expected font is in
the unused Latin slot, although the complex-script slot declares Arial. The
inverse Latin case, legacy/display/formal policies, missing used declarations
and mixed-body expectations are affected. It extracts field copy but inspects
only regular runs, letting a wrong field font hide beside an approved regular
run. Twelve actual regressions fail before repair; keep the original log.

Inspect each regular run and field in source order. For the existing Latin and
Arabic-script policy, select the explicit font slot by that run's actual text,
not by another declared slot or the script of the whole shape. Mixed runs must
satisfy each used script; formal mixed-body runs retain their individual script
families. Missing/ambiguous used-slot evidence refuses. Unused declarations do
not qualify a used slot or become observed-font evidence. Manual Client DNA
membership stays exact; existing generated/legacy family-style matching stays
unchanged. Whitespace-only runs do not invent visible font requirements.

This checks declarations in retained bytes, not font-file glyph coverage,
native rendering, future field-update behavior or source editability. Existing
source hashes/copy comparison/direction policy, external operation limits and
native/human review remain authoritative. No provider call, dependency,
automatic family inference or theme/default inheritance is added. Checker
version increments so saved receipts identify the stronger inspection.

Acceptance: original failures pass; wrong/missing/conflicting used fonts and
field fonts refuse; correct mixed/field sources preserve exact live copy and
bytes; existing native export fixtures/transfer/RTL tests pass; Core rechecks
retained artifacts despite older passing receipts, preventing approval of a
failed font check while nativeVerification stays unverified. Seal and qualify
source separately from production/native/human admission.

Primary format sources, accessed 2026-10-01:
- https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.complexscriptfont?view=openxml-3.0.1
- https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.latinfont?view=openxml-3.0.1
- https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.field?view=openxml-3.0.1


Exact source qualification: clean d6aef7ef full suite6770pass/0fail/67skip,
684 strict roots,7 technical stages pass. The first invocation omitted the
snapshot override and explicitly skipped Stage3; retain its original receipt.
A separate actual restore/migration/invariant run against newest production dump
predeploy_20261001T090959Z on the same unchanged candidate passes. No production
mutation or complete native/human admission is inferred. Exact combined proof:
plans/content-aware-design-2026-09-30/W5_PPTX_SCRIPT_FONT_GATE_EVIDENCE.json.
