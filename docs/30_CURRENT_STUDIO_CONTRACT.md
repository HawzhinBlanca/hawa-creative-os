# Current editable-studio contract

**Decision authority:** [ADR 025](../adrs/025_canva_only_archive.md), accepted 2026-09-13. **Reconciled:** 2026-09-25. This page defines the active source and export contract. Earlier HyCanvas and fallback-editor instructions in the 2026-09-03 research freeze are historical records, not an admission path.

## Selected boundary

Canva is the sole active editor and exporter. The native Canva design ID and URL identify the working editable master. Hawa owns the task, brief, copy, assets, revision ledger, approval, and publication identity. A PPTX or other interchange file used to import structured elements into Canva is an input artifact, not a second user editor or a guaranteed lossless backup of later Canva edits.

The design is reviewable only after Hawa captures the real Canva design ID and a current export. An uncaptured, inaccessible, or stale design is `unknown` or `not_captured`, never an invented ID or a passed editability check. The selected Canva design and captured export must be bound to the task's revision and content hashes before approval. A later edit requires a new capture and invalidates the earlier approval if rendered or semantic content changed.

## Source and recovery package

For each approved revision, retain an immutable package with:

- Canva design ID, edit URL, account/workspace identifier and capture time;
- exact approved copy, semantic element map where extraction supports it, dimensions, locale, direction, and supported editable element classes;
- original approved assets, official asset IDs and hashes, font references, and the import/operation recipe with versioned inputs;
- final Canva export bytes, MIME, SHA-256, QA profile and result, approval identity, and publication receipts;
- PNG and requested PDF exports, plus any other *actually produced and verified* standard format.

The manifest may help reconstruct a design if Canva becomes unavailable. It does **not** prove arbitrary manual Canva edits can be reproduced outside Canva. Portability is admitted element by element through an export, edit, reopen and reconstruction drill. Text, logos, photos, vectors, groups and Sorani typography must each be reported as restored, partially restored, or lost. No `.hyc` file is part of the current contract; SVG/PPTX/PSD are optional only when produced and their actual editability is measured.

## Admission evidence

Before a task is called editable and ready for review, prove that the native Canva source opens with independent live text and required assets, that the captured export matches the pinned revision, and that exact-copy, asset, glyph, layout and format gates pass on that export. Missing source inspection or unavailable export is an unknown result requiring operator review. The release and restore drills in [acceptance gates](29_ACCEPTANCE_GATES.md) and the [research-grade upgrade plan](../plans/research-grade-upgrade-2026-09-25/PLAN.md) determine whether the implementation has met this contract; this page itself is not proof of those tests.

## Supersession map

ADR 025 supersedes the studio selection, `.hyc` source, HyCanvas proof sprint, Penpot/Shotluma fallback, and backup-without-Canva promises in the initial versions of `AI_BUILD_PROMPT.md`, `DECISION_SUMMARY.md`, `MASTER_SPEC.md`, `docs/06_EDITABLE_DOCUMENT_STRATEGY.md`, and `docs/11_QA_RTL_MULTILINGUAL.md`. The historical baseline remains in Git before this reconciliation and in [ADR 025](../adrs/025_canva_only_archive.md); it must not be used to qualify the present system. A future foundation change requires a new ADR and new proof.

## Manual designs without an import (ADR-077)

A blank native design may be checked against the manual Desk request’s exact saved
copy and active, hash-verified, human-authored Client DNA font families. The export
operation freezes the policy and its version before submission. This creates no
imported-source record. Superseded policy remains historical evidence but cannot
qualify a new review, approval or publication. Family membership does not establish
font-file glyph coverage, native editability or visual quality. See
[ADR-077](../adrs/077_manual_canva_export_policy.md) for the boundary and acceptance.
