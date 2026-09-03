# Cost and Hardware Plan

## 1. Cost philosophy

This is private office software, so optimize total operational value—not SaaS gross margin or minimum infrastructure line items.

Spend on:

- reliable storage/backups/UPS;
- a capable editable workstation;
- high-value model calls;
- good fonts/templates/Client DNA curation;
- evaluation and language review.

Avoid recurring services that merely replace simple self-hosted capabilities.

## 2. Software baseline

Most selected infrastructure is self-hosted/open or source-available for internal use:

- PostgreSQL/pgvector;
- Restate;
- Hawa Desk/API;
- Phoenix/OpenTelemetry;
- Docling;
- ComfyUI;
- local Qwen embedding/reranker;
- Telegram Bot API;
- HyCanvas under Elastic License 2.0 for internal use, subject to preserving terms/notices.

Variable costs are primarily frontier reasoning/image APIs, Google Workspace, backup storage, and optional WAHA/support.

## 3. Hardware profiles

### Profile A — Lean proof/MVP

- 12–16 core CPU;
- 64 GB RAM;
- 2× NVMe mirrored;
- UPS;
- no dedicated GPU initially or existing 16 GB GPU;
- hosted image/reasoning models;
- local 2B retrieval on GPU or CPU-acceptable proof service.

### Profile B — Recommended office

- 16+ core CPU;
- 64–128 GB RAM;
- mirrored enterprise NVMe plus backup storage;
- 24 GB+ GPU;
- UPS and monitored thermals;
- local embeddings/reranking and selected image workflows;
- hosted frontier models for high-value creative reasoning.

### Profile C — Later split

- resilient core server without GPU dependency;
- separate high-VRAM GPU workstation/worker;
- optional warm spare core;
- useful only after measured queue/availability need.

Current retail hardware prices vary heavily by region and date; obtain local quotes after Phase 0 proves the VRAM/throughput requirement.

## 4. API-use envelope

The dominant variables are:

- number of tasks;
- percentage requiring new imagery;
- candidate count;
- resolution;
- deep-model escalation rate;
- repair count;
- context size;
- whether local generation is useful.

Recommended controls:

- routine template tasks target near-zero image-generation calls;
- novel tasks start with one art-direction reference and only necessary assets;
- 2–3 direction cap;
- 2 automatic repair cap;
- estimated cost shown before high-cost rerun;
- per-client/month and per-task budgets.

## 5. Engineering effort

| Scope | Estimated effort |
|---|---:|
| Phase 0 proof | 80–140 engineering hours + design/language review |
| Core MVP through routine editable production | 280–430 engineering hours |
| Creative Asset Lab, publication, feedback, hardening | 170–270 engineering hours |
| Total hardened pilot | **450–700 engineering hours** |

HyCanvas patching or fallback-editor work is the largest uncertainty.

## 6. Ongoing operations

Expected human work:

- client onboarding and DNA cleanup;
- template/style-family maintenance;
- approval and native-language review;
- model/editor upgrade evaluations;
- backup/restore drills;
- adapter session management;
- incident handling.

Automation should reduce repetitive design and tracking labor, not pretend those governance tasks disappear.
