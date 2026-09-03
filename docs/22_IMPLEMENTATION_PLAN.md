# Implementation Plan

## Team

- 1 senior TypeScript/AI systems engineer full-time;
- 1 product/process owner from the office;
- 1 designer part-time;
- 1 native Sorani/Arabic reviewer part-time;
- infrastructure/security review at proof and pilot gates.

Estimated engineering effort: **450–700 hours** for a hardened office pilot, depending primarily on HyCanvas patching and adapter behavior.

## Phase 0 — Prove the risky core (Weeks 1–2)

- execute HyCanvas proof sprint;
- run RTL/editor/export corpus;
- spike Restate task/review workflow;
- prove Telegram event persistence/deduplication;
- benchmark initial model/retrieval candidates on a seed set;
- finalize studio admission ADR.

**Exit:** editor accepted or fallback selected; no architecture assumption remains untested at the highest-risk seam.

## Phase 1 — Office foundation (Weeks 3–4)

- Hawa Desk shell, auth, roles, client/project administration;
- PostgreSQL schema/RLS/audit/inbox/outbox;
- Hono OpenAPI service;
- Restate task state machine;
- Telegram adapter;
- direct task form and routing review;
- operational dashboards/logging.

**Exit:** one message/direct request becomes one recoverable task and survives restarts/replays.

## Phase 2 — Client DNA and brief intelligence (Weeks 5–6)

- curated Drive ingestion through Docling;
- Client DNA editor/versioning;
- exact/trigram/vector retrieval;
- initial embedding/reranker service;
- model registry and structured brief builder;
- routing/brief evaluation harness;
- prompt-injection/client-isolation tests.

**Exit:** task resolves/gates client, produces evidence-backed brief, and retrieves only permitted material.

## Phase 3 — Editable routine production (Weeks 7–8)

- studio adapter and source package;
- approved templates/style families;
- exact text/asset operations;
- variants/resize;
- hard QA and RTL golden tests;
- embedded review and manual editing;
- approval tied to immutable revision.

**Exit:** routine posts complete end-to-end with editable source and zero critical escapes.

## Phase 4 — Creative engine and Asset Lab (Weeks 9–10)

- Editable-Design-style private reference/reconstruction runner;
- ComfyUI isolated worker and graph registry;
- direct image-provider adapters;
- creative DesignPlan and asset topology;
- independent visual judge;
- bounded targeted repair;
- cost/budget controls.

**Exit:** novel designs produce editable structured output with evidence and human control.

## Phase 5 — Publication, feedback, pilot (Weeks 11–12)

- Shared Drive source/final publication;
- Sheets upsert/reconciliation;
- adapter notifications;
- feedback ledger/rule proposals;
- Phoenix datasets/evaluations;
- backup/PITR/restore drill;
- fault injection and office pilot;
- optional WAHA isolated adapter after core is stable.

**Exit:** 3-client live office pilot and signed acceptance results.

## Prioritization

### Must

- Hawa Desk canonical state;
- client isolation;
- editable source;
- exact copy/asset/dimension QA;
- durable/replay-safe workflow;
- human approval;
- Drive/Sheet publication and reconciliation;
- Sorani/Arabic proof;
- backup restore.

### Should

- novel creative reference/reconstruction;
- local multimodal retrieval;
- model tournament and shadowing;
- node-targeted feedback;
- optional WAHA.

### Later

- selective auto-approval;
- broader channels;
- client-facing review portal;
- advanced collaboration;
- fine-tuning;
- multi-host HA.

## Definition of done

A feature is done only when:

- requirement and acceptance criteria pass;
- authorization/client isolation tested;
- idempotency/retry behavior tested;
- telemetry and safe error action exist;
- backup/migration impact documented;
- multilingual impact tested where relevant;
- operator documentation updated;
- no provider-specific type leaks into domain contracts.
