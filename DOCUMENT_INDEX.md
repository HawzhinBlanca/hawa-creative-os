# Document Index

**Specification version:** 1.0.0  
**Research freeze:** 2026-09-03  
**Audience:** product owner, coding agent, engineer, designer, QA, operator, and security reviewer.

## Fastest reading paths

### Owner / decision maker

1. `DECISION_SUMMARY.md`
2. `docs/00_EXECUTIVE_VERDICT.md`
3. `docs/02_PRD.md`
4. `docs/24_COST_HARDWARE.md`
5. `docs/29_ACCEPTANCE_GATES.md`

### AI coding agent / implementation team

1. `AGENTS.md` and `AI_BUILD_PROMPT.md`
2. `MASTER_SPEC.md`
3. `docs/03_SRS.md` and `docs/04_SYSTEM_ARCHITECTURE.md`
4. `plans/requirements.csv`, `plans/traceability.csv`, and `plans/backlog.csv`
5. `api/openapi.yaml`, `db/*.sql`, `contracts/*.ts`, and `schemas/*.json`
6. The subsystem document and ADR linked to each task

### Creative/graphics proof team

1. `docs/05_CREATIVE_ENGINE.md`
2. `docs/06_EDITABLE_DOCUMENT_STRATEGY.md`
3. `docs/11_QA_RTL_MULTILINGUAL.md`
4. `docs/21_HYCANVAS_PROOF_SPRINT.md`
5. `evals/rtl_golden_cases.jsonl` and `evals/visual_quality_rubric.md`

### Operator / administrator

1. `docs/20_DEPLOYMENT_BACKUP_DR.md`
2. `docs/25_OPERATIONS_RUNBOOK.md`
3. `runbooks/`
4. `deployment/`
5. `docs/29_ACCEPTANCE_GATES.md`

## Top-level authority files

| File | Purpose |
|---|---|
| [`README.md`](README.md) | Package orientation and starting points. |
| [`DECISION_SUMMARY.md`](DECISION_SUMMARY.md) | The final selected architecture and confidence/admission gates. |
| [`MASTER_SPEC.md`](MASTER_SPEC.md) | Authoritative consolidated specification and system invariants. |
| [`AI_BUILD_PROMPT.md`](AI_BUILD_PROMPT.md) | Complete execution contract for an AI coding agent. |
| [`AGENTS.md`](AGENTS.md) | Compact repository rules for coding agents. |
| [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md) | License and upstream-component obligations/caveats. |
| [`.env.example`](.env.example) | Safe configuration names without secrets. |

## Numbered specification set

| File | Purpose |
|---|---|
| [`docs/00_EXECUTIVE_VERDICT.md`](docs/00_EXECUTIVE_VERDICT.md) | Final recommendation, the corrected architecture, and the assumptions that must remain explicit. |
| [`docs/01_REALITY_CHECK_AND_EVIDENCE.md`](docs/01_REALITY_CHECK_AND_EVIDENCE.md) | Evidence ledger separating inspected implementation, releases/CI, documentation claims, hypotheses, and unresolved proof. |
| [`docs/02_PRD.md`](docs/02_PRD.md) | Product problem, outcomes, users, scope, capabilities, exclusions, success measures, and product acceptance. |
| [`docs/03_SRS.md`](docs/03_SRS.md) | Detailed functional behavior, use cases, business rules, states, errors, and acceptance criteria. |
| [`docs/04_SYSTEM_ARCHITECTURE.md`](docs/04_SYSTEM_ARCHITECTURE.md) | Component boundaries, data/control flows, deployment topology, invariants, and replacement seams. |
| [`docs/05_CREATIVE_ENGINE.md`](docs/05_CREATIVE_ENGINE.md) | Creative Director, art-direction reference, asset topology, editable reconstruction, and bounded repair workflow. |
| [`docs/06_EDITABLE_DOCUMENT_STRATEGY.md`](docs/06_EDITABLE_DOCUMENT_STRATEGY.md) | Canonical `.hyc` source, neutral sidecar manifest, revision semantics, exports, round trips, and fallback portability. |
| [`docs/07_MODEL_REGISTRY_AND_EVALUATION.md`](docs/07_MODEL_REGISTRY_AND_EVALUATION.md) | Role-based model registry, tournament, promotion, shadowing, canaries, rollback, and deprecation handling. |
| [`docs/08_MEMORY_RAG_CLIENT_DNA.md`](docs/08_MEMORY_RAG_CLIENT_DNA.md) | Structured Client DNA, ingestion, hybrid/multimodal retrieval, provenance, negative memory, and isolation. |
| [`docs/09_MESSAGING_AND_OFFICE_INBOX.md`](docs/09_MESSAGING_AND_OFFICE_INBOX.md) | Hawa Desk canonical intake plus Telegram, optional WAHA, and future adapter contracts. |
| [`docs/10_WORKFLOW_RELIABILITY.md`](docs/10_WORKFLOW_RELIABILITY.md) | Restate workflow model, state machine, idempotency, retries, reconciliation, operator controls, and recovery. |
| [`docs/11_QA_RTL_MULTILINGUAL.md`](docs/11_QA_RTL_MULTILINGUAL.md) | Hard QA, visual QA, fonts, Unicode, Sorani/Arabic bidi, golden renders, native review, and repair limits. |
| [`docs/12_HUMAN_REVIEW.md`](docs/12_HUMAN_REVIEW.md) | Review workspace, approval authority, revision semantics, audit, and controlled auto-approval policy. |
| [`docs/13_GOOGLE_DRIVE_SHEETS.md`](docs/13_GOOGLE_DRIVE_SHEETS.md) | Shared Drive source packages, idempotent/resumable publishing, Sheet mirroring, and divergence reconciliation. |
| [`docs/14_SECURITY_THREAT_MODEL.md`](docs/14_SECURITY_THREAT_MODEL.md) | Assets, actors, trust boundaries, threats, mitigations, capability controls, and incident triggers. |
| [`docs/15_DATABASE_DESIGN.md`](docs/15_DATABASE_DESIGN.md) | Database domains, relationships, invariants, RLS, append-only records, retention, backup, and migration rules. |
| [`docs/16_API_EVENTS.md`](docs/16_API_EVENTS.md) | HTTP/event contracts, idempotency, optimistic concurrency, error envelopes, and webhook behavior. |
| [`docs/17_UI_UX.md`](docs/17_UI_UX.md) | Hawa Desk information architecture, screens, states, interaction rules, accessibility, and responsive behavior. |
| [`docs/18_FEEDBACK_LEARNING.md`](docs/18_FEEDBACK_LEARNING.md) | Structured correction capture, rule proposals, human promotion, examples, template scoring, and regression tests. |
| [`docs/19_OBSERVABILITY.md`](docs/19_OBSERVABILITY.md) | OpenTelemetry/Phoenix traces, metrics, evaluations, alerts, budgets, and operator diagnostics. |
| [`docs/20_DEPLOYMENT_BACKUP_DR.md`](docs/20_DEPLOYMENT_BACKUP_DR.md) | Private office deployment, network boundary, containers, storage, backup, PITR, restore tests, and DR. |
| [`docs/21_HYCANVAS_PROOF_SPRINT.md`](docs/21_HYCANVAS_PROOF_SPRINT.md) | Mandatory executable admission test for HyCanvas, including real-browser RTL, source, export, API, security, and failure proof. |
| [`docs/22_IMPLEMENTATION_PLAN.md`](docs/22_IMPLEMENTATION_PLAN.md) | Phases, milestones, dependencies, roles, artifacts, sequencing, and exit criteria. |
| [`docs/23_TEST_STRATEGY.md`](docs/23_TEST_STRATEGY.md) | Test pyramid, contract/golden/fault/security/evaluation suites, environments, evidence, and release gates. |
| [`docs/24_COST_HARDWARE.md`](docs/24_COST_HARDWARE.md) | Office-server/GPU options, operating-cost drivers, capacity assumptions, and staged spending. |
| [`docs/25_OPERATIONS_RUNBOOK.md`](docs/25_OPERATIONS_RUNBOOK.md) | Operational responsibilities, daily/weekly/monthly checks, escalation, and links to incident runbooks. |
| [`docs/26_WHAT_NOT_TO_BUILD.md`](docs/26_WHAT_NOT_TO_BUILD.md) | Explicit anti-scope and forbidden architecture choices that would reduce reliability or ownership. |
| [`docs/27_REPO_VENDOR_SCORECARD.md`](docs/27_REPO_VENDOR_SCORECARD.md) | Evidence-based comparison of candidate repositories, vendors, strengths, limitations, and assigned roles. |
| [`docs/28_SOURCE_REGISTER.md`](docs/28_SOURCE_REGISTER.md) | Primary repositories, official documentation, frozen evidence, and caveats used in the research. |
| [`docs/29_ACCEPTANCE_GATES.md`](docs/29_ACCEPTANCE_GATES.md) | Critical, release, pilot, security, RTL, recovery, and quality gates that define completion. |
| [`docs/30_FUTURE_EVOLUTION.md`](docs/30_FUTURE_EVOLUTION.md) | Safe paths for additional channels, models, local inference, motion/video, collaboration, and scale. |

## Architecture decision records

| File | Purpose |
|---|---|
| [`adrs/001_office_inbox.md`](adrs/001_office_inbox.md) | ADR-001: Make Hawa Desk the canonical office inbox |
| [`adrs/002_hycanvas_studio.md`](adrs/002_hycanvas_studio.md) | ADR-002: Use a pinned HyCanvas release as the first editable studio candidate |
| [`adrs/003_hyc_source.md`](adrs/003_hyc_source.md) | ADR-003: Use `.hyc` plus a neutral manifest as the creative source |
| [`adrs/004_restate.md`](adrs/004_restate.md) | ADR-004: Use Restate for durable workflow execution |
| [`adrs/005_single_controller.md`](adrs/005_single_controller.md) | ADR-005: Use one bounded controller instead of an agent swarm |
| [`adrs/006_model_registry.md`](adrs/006_model_registry.md) | ADR-006: Resolve AI by evaluated role through a versioned model registry |
| [`adrs/007_comfyui.md`](adrs/007_comfyui.md) | ADR-007: Use ComfyUI only as an isolated visual Asset Lab |
| [`adrs/008_postgres_client_dna.md`](adrs/008_postgres_client_dna.md) | ADR-008: Use PostgreSQL for Client DNA and hybrid retrieval |
| [`adrs/009_telegram_waha.md`](adrs/009_telegram_waha.md) | ADR-009: Use Telegram first and WAHA only as an isolated optional WhatsApp adapter |
| [`adrs/010_phoenix_otel.md`](adrs/010_phoenix_otel.md) | ADR-010: Use OpenTelemetry and self-hosted Phoenix for AI observability/evaluation |
| [`adrs/011_drive_sheets.md`](adrs/011_drive_sheets.md) | ADR-011: Use direct Google Drive/Sheets APIs as publication adapters |
| [`adrs/012_governed_learning.md`](adrs/012_governed_learning.md) | ADR-012: Learn through governed rules, examples, templates, and evaluations |
| [`adrs/013_direct_provider_adapters.md`](adrs/013_direct_provider_adapters.md) | ADR-013: Prefer direct model-provider adapters over a universal gateway |
| [`adrs/014_fallback_editor.md`](adrs/014_fallback_editor.md) | ADR-014: Maintain an executable fallback studio path |

## Machine-readable build contracts

| File | Purpose |
|---|---|
| [`plans/requirements.csv`](plans/requirements.csv) | 80 functional and 25 non-functional requirements with stable IDs. |
| [`plans/user-stories.csv`](plans/user-stories.csv) | 40 office user stories. |
| [`plans/backlog.csv`](plans/backlog.csv) | Prioritized implementation backlog tied to requirements and phases. |
| [`plans/traceability.csv`](plans/traceability.csv) | Requirement-to-document, phase, owner, verification, test, and evidence mapping. |
| [`plans/RACI.csv`](plans/RACI.csv) | Responsibility assignment for major work packages. |
| [`plans/risk-register.csv`](plans/risk-register.csv) | 30 risks with likelihood, impact, mitigation, owner, trigger, and contingency. |
| [`plans/mvp-checklist.md`](plans/mvp-checklist.md) | Operational checklist for the first complete office pilot. |
| [`api/openapi.yaml`](api/openapi.yaml) | OpenAPI 3.1 starting contract for Hawa Core. |
| [`api/events.md`](api/events.md) | Domain event names, envelopes, ordering, and compatibility rules. |
| [`db/schema.sql`](db/schema.sql) | PostgreSQL schema, constraints, indexes, event/audit structures, and helper functions. |
| [`db/rls.sql`](db/rls.sql) | Row-level-security policies and office/client authorization helpers. |
| [`db/seed.sql`](db/seed.sql) | Minimal role/status/bootstrap seed data. |

## JSON Schemas

| File | Purpose |
|---|---|
| [`schemas/ApprovalDecision.schema.json`](schemas/ApprovalDecision.schema.json) | Draft 2020-12 runtime contract for ApprovalDecision. |
| [`schemas/ClientDNA.schema.json`](schemas/ClientDNA.schema.json) | Draft 2020-12 runtime contract for ClientDNA. |
| [`schemas/DesignBrief.schema.json`](schemas/DesignBrief.schema.json) | Draft 2020-12 runtime contract for DesignBrief. |
| [`schemas/DesignPlan.schema.json`](schemas/DesignPlan.schema.json) | Draft 2020-12 runtime contract for DesignPlan. |
| [`schemas/FeedbackEvent.schema.json`](schemas/FeedbackEvent.schema.json) | Draft 2020-12 runtime contract for FeedbackEvent. |
| [`schemas/MessageEnvelope.schema.json`](schemas/MessageEnvelope.schema.json) | Draft 2020-12 runtime contract for MessageEnvelope. |
| [`schemas/ModelRegistry.schema.json`](schemas/ModelRegistry.schema.json) | Draft 2020-12 runtime contract for ModelRegistry. |
| [`schemas/QCReport.schema.json`](schemas/QCReport.schema.json) | Draft 2020-12 runtime contract for QCReport. |
| [`schemas/SourcePackageManifest.schema.json`](schemas/SourcePackageManifest.schema.json) | Draft 2020-12 runtime contract for SourcePackageManifest. |
| [`schemas/Task.schema.json`](schemas/Task.schema.json) | Draft 2020-12 runtime contract for Task. |

## TypeScript adapter contracts

| File | Purpose |
|---|---|
| [`contracts/asset-provider.ts`](contracts/asset-provider.ts) | Replaceable asset provider boundary and typed results/errors. |
| [`contracts/common.ts`](contracts/common.ts) | Replaceable common boundary and typed results/errors. |
| [`contracts/design-studio.ts`](contracts/design-studio.ts) | Replaceable design studio boundary and typed results/errors. |
| [`contracts/message-adapter.ts`](contracts/message-adapter.ts) | Replaceable message adapter boundary and typed results/errors. |
| [`contracts/model-gateway.ts`](contracts/model-gateway.ts) | Replaceable model gateway boundary and typed results/errors. |
| [`contracts/publisher.ts`](contracts/publisher.ts) | Replaceable publisher boundary and typed results/errors. |
| [`contracts/qa-engine.ts`](contracts/qa-engine.ts) | Replaceable qa engine boundary and typed results/errors. |
| [`contracts/retrieval.ts`](contracts/retrieval.ts) | Replaceable retrieval boundary and typed results/errors. |

## Evaluation and failure corpora

| File | Purpose |
|---|---|
| [`evals/routing_brief.jsonl`](evals/routing_brief.jsonl) | 60 multilingual client-routing, exact-copy, protected-token, ambiguity, and abstention cases. |
| [`evals/rtl_golden_cases.jsonl`](evals/rtl_golden_cases.jsonl) | 40 Sorani/Arabic/English/mixed-direction editor and render cases. |
| [`evals/retrieval_eval.jsonl`](evals/retrieval_eval.jsonl) | 20 client-scoped lexical/multimodal retrieval and leakage cases. |
| [`evals/fault_injection_matrix.csv`](evals/fault_injection_matrix.csv) | 36 interruption, retry, divergence, security, and recovery scenarios. |
| [`evals/model_eval_matrix.yaml`](evals/model_eval_matrix.yaml) | Role-specific metrics, weights, hard gates, challenger protocol, and promotion stages. |
| [`evals/visual_quality_rubric.md`](evals/visual_quality_rubric.md) | Human and model visual-review dimensions with severity rules. |

## Prompts

| File | Purpose |
|---|---|
| [`prompts/brief-builder.md`](prompts/brief-builder.md) | Versioned, schema-bound brief builder prompt contract. |
| [`prompts/client-rule-miner.md`](prompts/client-rule-miner.md) | Versioned, schema-bound client rule miner prompt contract. |
| [`prompts/creative-director.md`](prompts/creative-director.md) | Versioned, schema-bound creative director prompt contract. |
| [`prompts/feedback-classifier.md`](prompts/feedback-classifier.md) | Versioned, schema-bound feedback classifier prompt contract. |
| [`prompts/intake-router.md`](prompts/intake-router.md) | Versioned, schema-bound intake router prompt contract. |
| [`prompts/visual-judge.md`](prompts/visual-judge.md) | Versioned, schema-bound visual judge prompt contract. |

## Configuration examples

| File | Purpose |
|---|---|
| [`config/asset-workflows.example.yaml`](config/asset-workflows.example.yaml) | Example asset workflows.yaml configuration; never contains live secrets. |
| [`config/client-dna.example.yaml`](config/client-dna.example.yaml) | Example client dna.yaml configuration; never contains live secrets. |
| [`config/comfy-node-lock.example.json`](config/comfy-node-lock.example.json) | Example comfy node lock.json configuration; never contains live secrets. |
| [`config/model-registry.example.yaml`](config/model-registry.example.yaml) | Example model registry.yaml configuration; never contains live secrets. |
| [`config/provider-policy.example.yaml`](config/provider-policy.example.yaml) | Example provider policy.yaml configuration; never contains live secrets. |
| [`config/upstream-components.example.yaml`](config/upstream-components.example.yaml) | Example upstream components.yaml configuration; never contains live secrets. |

## Diagrams

| File | Purpose |
|---|---|
| [`diagrams/architecture.dot`](diagrams/architecture.dot) | Graphviz source. |
| [`diagrams/architecture.mmd`](diagrams/architecture.mmd) | Mermaid source. |
| [`diagrams/architecture.svg`](diagrams/architecture.svg) | Rendered portable diagram. |
| [`diagrams/data-flow.dot`](diagrams/data-flow.dot) | Graphviz source. |
| [`diagrams/data-flow.mmd`](diagrams/data-flow.mmd) | Mermaid source. |
| [`diagrams/data-flow.svg`](diagrams/data-flow.svg) | Rendered portable diagram. |
| [`diagrams/deployment.dot`](diagrams/deployment.dot) | Graphviz source. |
| [`diagrams/deployment.mmd`](diagrams/deployment.mmd) | Mermaid source. |
| [`diagrams/deployment.svg`](diagrams/deployment.svg) | Rendered portable diagram. |
| [`diagrams/workflow.dot`](diagrams/workflow.dot) | Graphviz source. |
| [`diagrams/workflow.mmd`](diagrams/workflow.mmd) | Mermaid source. |
| [`diagrams/workflow.svg`](diagrams/workflow.svg) | Rendered portable diagram. |

## UI/UX artifacts

| File | Purpose |
|---|---|
| [`ui/design-system.md`](ui/design-system.md) | Office UI tokens, components, state and accessibility rules. |
| [`ui/user-flows.md`](ui/user-flows.md) | Task, review, correction, failure, Client DNA, and evaluation flows. |
| [`ui/wireframes.html`](ui/wireframes.html) | Self-contained browser-viewable wireframes for the principal Hawa Desk screens. |

## Deployment and recovery examples

| File | Purpose |
|---|---|
| [`deployment/Caddyfile`](deployment/Caddyfile) | Deployment/recovery artifact: Caddyfile. |
| [`deployment/Dockerfile.hawa`](deployment/Dockerfile.hawa) | Deployment/recovery artifact: Dockerfile.hawa. |
| [`deployment/backup.sh`](deployment/backup.sh) | Deployment/recovery artifact: backup.sh. |
| [`deployment/docker-compose.yml`](deployment/docker-compose.yml) | Deployment/recovery artifact: docker-compose.yml. |
| [`deployment/env.example`](deployment/env.example) | Deployment/recovery artifact: env.example. |
| [`deployment/init-databases.sh`](deployment/init-databases.sh) | First-boot creation of isolated Hawa, HyCanvas, and Phoenix databases/roles. |
| [`deployment/restore-test.sh`](deployment/restore-test.sh) | Deployment/recovery artifact: restore-test.sh. |

## Incident runbooks

| File | Purpose |
|---|---|
| [`runbooks/01_task_failure.md`](runbooks/01_task_failure.md) | Runbook: Failed or Stuck Task |
| [`runbooks/02_adapter_gap.md`](runbooks/02_adapter_gap.md) | Runbook: Messaging Adapter Gap or Outage |
| [`runbooks/03_model_provider_outage.md`](runbooks/03_model_provider_outage.md) | Runbook: Model Provider Outage or Regression |
| [`runbooks/05_rtl_failure.md`](runbooks/05_rtl_failure.md) | Runbook: Sorani/Arabic/RTL Failure |
| [`runbooks/06_publication_reconciliation.md`](runbooks/06_publication_reconciliation.md) | Runbook: Drive/Sheets Publication Divergence |
| [`runbooks/07_security_incident.md`](runbooks/07_security_incident.md) | Runbook: Security or Cross-Client Incident |
| [`runbooks/08_comfyui_quarantine.md`](runbooks/08_comfyui_quarantine.md) | Runbook: ComfyUI Node or Workflow Quarantine |
| [`runbooks/09_waha_reauth_kill_switch.md`](runbooks/09_waha_reauth_kill_switch.md) | Runbook: WAHA Reauthentication or Kill Switch |
| [`runbooks/10_backup_restore.md`](runbooks/10_backup_restore.md) | Runbook: Backup and Clean-Host Restore |
| [`runbooks/11_upgrade.md`](runbooks/11_upgrade.md) | Runbook: Dependency, Model, or Studio Upgrade |
| [`runbooks/12_emergency_manual_mode.md`](runbooks/12_emergency_manual_mode.md) | Runbook: Emergency Manual Production Mode |

## Validation and integrity

| File | Purpose |
|---|---|
| [`scripts/validate_pack.py`](scripts/validate_pack.py) | Executable structural validator for the complete specification package. |
| [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md) | Human-readable record of the checks actually executed in this environment. |
| [`MANIFEST.json`](MANIFEST.json) | Machine-readable file inventory with sizes and SHA-256 hashes, excluding self-referential integrity files. |
| [`SHA256SUMS.txt`](SHA256SUMS.txt) | SHA-256 checksum list for package files, excluding the checksum file itself. |

## Authority and conflict rules

1. Security and client-isolation rules cannot be weakened by prompts, UI convenience, or provider behavior.
2. `plans/requirements.csv` supplies stable requirement IDs; detailed meaning comes from the linked numbered document.
3. ADRs explain selected decisions; a superseding ADR is required for a material architecture change.
4. OpenAPI, JSON Schemas, SQL constraints, and TypeScript contracts must be generated or tested against each other to prevent drift.
5. A vendor README or passing upstream CI never overrides `docs/21_HYCANVAS_PROOF_SPRINT.md` or `docs/29_ACCEPTANCE_GATES.md`.
6. Evidence from executable tests outranks architectural confidence estimates.
