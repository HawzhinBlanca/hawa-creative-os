# Phase 0 — HyCanvas Proof Sprint

**Duration:** 10 working days  
**Decision:** admit, patch-and-admit, or reject HyCanvas as the primary editable studio.

## 1. Why this is mandatory

HyCanvas is unusually promising but young. Repository source, releases, and CI do not prove this office’s Sorani, Arabic, export, recovery, and automation requirements.

No later implementation phase may assume HyCanvas passed.

## 2. Frozen candidate

- Start from release **v0.3.9** and record release checksum.
- Also test any selected patch commit only in a separate candidate build.
- Preserve source/license notices.
- Disable automatic update.
- Record Node/Go/PostgreSQL/browser/font versions.

## 3. Installation proof

- install prebuilt binary and source build on clean Linux host;
- verify release checksum;
- complete setup without undocumented external services;
- use PostgreSQL and local/S3-compatible storage configuration intended for production;
- verify health/version endpoints;
- restart host/process and confirm persistence;
- export/import `.hyc` on a clean second instance.

## 4. Editable document proof

Create at least 20 real representative designs:

- text-led poster;
- podcast episode card;
- guest quote;
- event poster;
- sponsor/product card;
- multi-format campaign set;
- continuous-scene composition;
- cutout stack;
- collage;
- data/chart card.

For each:

- edit text, image, vector, group, crop, effect, layer order;
- save/close/reopen;
- duplicate/adapt dimensions;
- export required formats;
- verify source hash/manifest;
- verify no required element is flattened.

## 5. Sorani/Arabic proof

Run every case in `evals/rtl_golden_cases.jsonl` plus at least 20 real office Sorani designs.

Test:

- editor display;
- selection/caret/delete/copy/paste;
- mixed style runs;
- wrapping/alignment;
- browser preview;
- server/client exports;
- PNG/SVG/PDF/PPTX where required;
- custom font upload/use;
- missing-font behavior;
- paired brackets and isolate controls;
- mixed numerals/currency/URLs/hashtags.

Two native reviewers sign critical-case results.

## 6. API/automation proof

- create/open/fetch a document programmatically;
- apply exact node-level edits;
- use expected revision/optimistic concurrency in adapter;
- create editable design via supported generation path;
- upload/use approved assets;
- render previews/exports;
- retrieve semantic manifest;
- test MCP only as optional surface, not as trusted business authority;
- prove malformed/model-generated commands cannot escape the adapter schema.

## 7. Round-trip and parity

For every representative design:

- `.hyc` save/open semantic diff = no unexplained loss;
- preview/export dimensions exact;
- extracted text equals source;
- official asset hashes preserved;
- pixel comparison within declared anti-aliasing tolerance;
- browser and server renderer discrepancies documented and either fixed or routed to one authoritative path.

## 8. Interruption and concurrency

Inject:

- process kill during save/render/export;
- database restart;
- lost response after successful operation;
- two editors modifying same revision;
- stale automation command;
- storage full/permission failure;
- malformed source document;
- source schema migration across supported versions.

No silent overwrite or corrupted approved source is permitted.

## 9. Performance

Measure on office hardware:

- open/save/render/export for small, medium, and complex designs;
- memory/CPU/disk use;
- 5–10 concurrent office users or realistic serialized workload;
- large image/font behavior;
- cold restart and recovery.

Set actual budgets after measurement; do not invent them beforehand.

## 10. Security

- authenticate/authorize every studio operation;
- verify workspace/client separation;
- validate upload/path handling;
- test external resource loading and SVG/HTML/script sanitization;
- verify secret encryption/config boundaries;
- confirm no unneeded public endpoints;
- run dependency/container scans;
- verify Elastic License obligations for internal use/modification.

## 11. Admission thresholds

### Critical—must all pass

- live editable source for every required design;
- no critical Sorani/Arabic semantic or visual failure;
- no cross-client access;
- no silent source loss/corruption;
- exact dimensions and copy;
- automation adapter can make scoped edits safely;
- clean backup/import restore;
- one authoritative export path meets quality;
- acceptable internal-use license path.

### High—may admit with bounded patch

- specific non-critical export discrepancy;
- missing convenience operation;
- limited template feature;
- performance issue with known workaround;
- paired-bracket/isolate behavior handled by fallback renderer.

## 12. Decision outcomes

### Admit

Pin candidate, write adapter compatibility tests, and proceed.

### Patch and admit

Maintain a small office fork with explicit patch list, upstream tracking, and rebase tests.

### Reject

Activate the fallback spike: Penpot versus focused Shotluma/Tela-based editor plus Chromium renderer. The rest of Hawa Creative OS remains unchanged.

## 13. Deliverables

- executable test report;
- screenshots/render corpus;
- source/semantic diffs;
- performance/security results;
- patch list;
- final ADR with confidence;
- pinned binary/source/container checksums;
- rollback/fallback recommendation.
