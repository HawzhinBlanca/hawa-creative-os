> Current studio decision: Canva only ([ADR 025](../adrs/025_canva_only_archive.md), 2026-09-13). [The current source and recovery contract](30_CURRENT_STUDIO_CONTRACT.md) supersedes the 2026-09-03 HyCanvas and fallback proposal. The earlier text remains in Git history and archived editor records; it must not be re-enabled without a new ADR.

# Editable Document Strategy

## 1. Non-negotiable requirement

Every automatically produced graphic must have a valid editable source. PNG/JPEG/PDF previews alone are never considered a completed design.

## 2. Canonical source

The working creative master is the native Canva design. Hawa records the real Canva design ID and edit URL, a pinned captured export, the approved copy, source assets, import recipe and an immutable semantic/revision manifest. Interchange files used for import do not automatically contain later human edits.

Hawa Creative OS does not store only a foreign document ID. It stores:

- the real Canva ID, workspace, capture time and export hash;
- exact input/asset/recipe hashes and captured semantic source where the API supports it;
- Canva adapter/API versions and any unavailable inspection capability;
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
source/canva-design-and-revision.json
source/import-recipe.json
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
- explicit measurement of reconstruction from Hawa's package without Canva, including any lost manual edits;
- reasonable performance on office hardware.

## 9. Canva-specific cautions

- Pin adapter/API behavior and test every import, edit, export and capture path independently.
- Verify native live text and required assets in the working design; inspect exported text and glyphs where available.
- Treat unsupported Canva elements or unavailable source inspection as unknown, not as evidence of full editability.
- Maintain the Hawa source package and standard exports, while stating that arbitrary manual edits may be lost in reconstruction.

## 10. Outage and recovery

Canva outage pauses new editing/export. Hawa retains task, approval, source assets, recipe and prior verified exports so an operator can recover or complete work after service restoration. Retired editor providers are not automatic fallbacks. A human may use a separate tool only through a newly approved source-ingestion/export workflow; it cannot silently satisfy this contract.

## 11. Migration drill

Quarterly, export selected designs and verify:

- the native Canva design opens in the authorized workspace and its captured revision matches the retained export;
- all linked assets/fonts resolve;
- live text is extractable;
- standard outputs match golden tolerances;
- neutral manifest matches document semantics;
- representative designs are reconstructed from Hawa's package, with every lost or partial element reported.
