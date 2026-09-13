> Current studio decision: Canva only (ADR 025, 2026-09-13). HyCanvas passages below are historical and must not be implemented or re-enabled.

# Editable Document Strategy

## 1. Non-negotiable requirement

Every automatically produced graphic must have a valid editable source. PNG/JPEG/PDF previews alone are never considered a completed design.

## 2. Canonical source

For the first implementation, the creative source is a pinned HyCanvas `.hyc` document. It is readable JSON and should contain real text, images, vectors, groups, masks, fills, effects, charts, tables, artboards/pages, and document metadata.

Hawa Creative OS does not store only a foreign document ID. It stores:

- the exact `.hyc` bytes;
- source hash;
- HyCanvas release/commit and schema version;
- an immutable neutral sidecar manifest;
- standard preview/export files;
- font and asset references/checksums;
- operation log and parent revision.

## 3. Neutral sidecar manifest

The sidecar is not a second renderer. It is a migration/recovery index containing:

- artboard IDs, names, dimensions, units, and language/direction;
- every live text string and node ID;
- official asset IDs/hashes and node use;
- generated asset IDs/hashes/provenance;
- font family/style/file hashes;
- palette tokens and used colors;
- layer names, roles, order, and lock status;
- template/style-family version;
- expected export set;
- source and preview hashes;
- QC and approval hashes.

This makes it possible to detect loss during an editor migration and reconstruct important semantics even if the original studio disappears.

## 4. Revision semantics

- Every save that changes rendered or semantic content creates a new immutable `design_revision`.
- Autosaves may remain transient until checkpointed, but human approval always targets an immutable revision hash.
- Any post-approval content change invalidates approval and returns the task to review.
- A comment-only or metadata-only change may preserve approval only when explicitly classified as non-rendering and verified by equal render/source semantic hashes.
- Revision parentage must be a DAG-safe linear history for production tasks; branches may be used for design directions and merged only through explicit selection.

## 5. Node requirements

All factual and brand-critical elements must remain independent:

- headline/body/price/date/contact/legal copy;
- official logos and sponsor marks;
- QR codes;
- client/product names;
- charts and reported numbers;
- CTA and buttons;
- photography/product/subject assets when local repositioning is expected.

The system may use a continuous raster scene only for visual content that genuinely depends on shared lighting/perspective and contains no required text or official logo.

## 6. AI operation safety

Studio commands use optimistic concurrency:

```text
operation_id
idempotency_key
studio_document_id
expected_revision_hash
actor/model identity
command type
validated arguments
scope of permitted nodes
```

A stale revision produces a conflict; it must never silently overwrite a newer human edit.

Destructive commands—delete page, replace full design, detach official asset, flatten text, or change dimensions—require stronger authorization and may require confirmation.

## 7. Export set

Approved tasks normally produce:

```text
source/design.hyc
source/manifest.json
source/assets/*
source/fonts-manifest.json
final/{variant}.png
final/{variant}.jpg (when requested)
final/{variant}.pdf (when requested)
proof/contact-sheet.pdf or png
qa/qc-report.json
qa/qc-report.html
meta/brief.json
meta/design-plan.json
meta/provenance.json
meta/approval.json
```

SVG/PPTX/PSD are optional routes and must be labeled according to actual editability. A partially editable conversion must not be advertised as lossless.

## 8. Studio admission criteria

A studio is eligible only when it can prove:

- source round-trip with no semantic loss;
- live English/Sorani/Arabic text;
- mixed-direction editing and export;
- custom fonts and font packaging/reference integrity;
- deterministic dimensions and export size;
- image/vector/group/mask manipulation;
- script/API or safe automation surface;
- revision conflict handling or adapter-enforced locking;
- backup/export without vendor cloud dependence;
- reasonable performance on office hardware.

## 9. HyCanvas-specific cautions

- Pin exact release/commit; no automatic upstream pulls.
- Preserve Elastic License notices and do not expose the system as a managed third-party service.
- Treat its UAX #9 implementation as a tested subset, not complete Unicode bidi support.
- Do not rely on roadmap features.
- Verify every export path independently.
- Maintain the neutral sidecar and standard exports.
- Keep the adapter small enough to replace.

## 10. Fallback hierarchy

1. **HyCanvas** after Phase 0 pass.
2. **Penpot adapter** for collaborative/vector-heavy work if HyCanvas fails critical needs.
3. **Focused editor assembled from Shotluma/Tela/Fabric/Konva concepts** only for the subset needed by the office.
4. **Chromium HTML/SVG reconstruction** for exact copy/RTL and emergency source preservation.
5. Human designer in an external native tool with a source-ingestion/export contract.

No fallback may publish flat-only output as complete.

## 11. Migration drill

Quarterly, export selected designs and verify:

- source opens on a clean pinned studio installation;
- all linked assets/fonts resolve;
- live text is extractable;
- standard outputs match golden tolerances;
- neutral manifest matches document semantics;
- at least one representative design can be reconstructed in the fallback path.
