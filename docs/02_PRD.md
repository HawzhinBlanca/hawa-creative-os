# 02 — Product Requirements Document

## Product

**Hawa Creative OS** — an office-owned AI creative operations worker for a multi-client media company.

## Problem

Graphic requests currently begin in fragmented conversations. People must infer the client, search prior work, interpret feedback, find assets, create and revise graphics, place files in the right Drive folders, update tracking sheets, and remember preferences. Repetition is high, handoffs are lossy, and critical creative knowledge lives in people’s heads and chat history.

Existing products usually solve only one segment: chat, asset generation, template rendering, brand memory, approval, or project tracking. They rarely provide a complete, editable, multilingual, multi-client loop while remaining private and replaceable.

## Goals

- Turn explicit office messages into correctly routed design tasks.
- Preserve exact client facts and copy.
- Reuse approved knowledge and learn governed preferences.
- Produce genuinely editable designs at professional quality.
- Support English, Sorani, Arabic, and mixed-direction content.
- Make failures recoverable and visible.
- Complete filing, tracking, and feedback work automatically.
- Remain useful even when a chat provider, model, or editor changes.

## Non-goals

- Building a general-purpose social network or chat system.
- Replacing professional designers for every novel campaign.
- Publishing directly to social platforms in the initial release.
- Training a foundational image or language model.
- Providing a public multi-tenant SaaS.
- Achieving literal zero downtime or zero defects.

## Users

| Role | Primary needs |
|---|---|
| Requester | Submit a task from normal office work, see status, answer missing facts. |
| Project manager | Correct routing, priorities, due dates, and approval paths. |
| Designer | Inspect context, edit layered files, compare revisions, preserve craft. |
| Language reviewer | Verify Sorani/Arabic copy, direction, numbers, terms, and cultural fit. |
| Client/brand approver | Approve exact versions with clear evidence and links. |
| Client-memory manager | Maintain assets, rules, templates, examples, and feedback scope. |
| Operator | Recover failed workflows, reconcile integrations, manage provider health. |
| Administrator | Manage identities, permissions, adapters, models, backups, and policy. |

## Product principles


1. **The office inbox is canonical.** Chat products are adapters, never the database or state machine.
2. **Every final design remains editable.** Exact copy, logos, shapes, vectors, charts, and layout are structured nodes—not flattened AI pixels.
3. **Image models create visual ingredients and private art-direction references, not the final factual poster.**
4. **One durable workflow replaces an agent swarm.** AI is invoked only at bounded, schema-validated decision points.
5. **Client scope is fixed before retrieval.** Cross-client search followed by model filtering is prohibited.
6. **Models are replaceable and evaluated by role.** No unversioned “best model” alias is trusted in production.
7. **Hard rules outrank model judgment.** The visual judge is advisory and cannot override exact-copy, dimensions, asset, permission, or RTL failures.
8. **Learning is governed.** Feedback becomes evidence, candidate rules, templates, and evaluation cases; it never silently rewrites Client DNA.
9. **Every external side effect is idempotent, replayable, and auditable.**
10. **“Bulletproof” means fail-closed, recoverable, observable, replaceable, and restore-tested—not impossible to fail.**


## Functional requirements

- **FR-001 — Canonical task creation:** The system shall create tasks through Hawa Desk and adapter events without making any chat platform authoritative.
- **FR-002 — Raw event retention:** The system shall preserve the normalized source event, source identifier, edit history, attachments, and thread context according to retention policy.
- **FR-003 — Webhook verification:** Each adapter shall authenticate incoming events using the strongest source-supported mechanism before persistence.
- **FR-004 — Event idempotency:** A repeated source event shall produce exactly one logical message event and no more than one task.
- **FR-005 — Task promotion:** Passive messages shall become production tasks only through an explicit command, mention, reaction, Hawa Desk action, or approved classifier policy.
- **FR-006 — Manual intake:** Authorized users shall create tasks directly in Hawa Desk with files, exact copy, dimensions, due date, and client/project selection.
- **FR-007 — Client channel mapping:** The system shall support versioned mappings from channel, group, topic, sender, alias, and campaign code to allowed clients/projects.
- **FR-008 — Deterministic routing first:** Client/project resolution shall apply deterministic evidence before model classification.
- **FR-009 — Candidate-limited AI routing:** The routing model shall receive only clients/projects permitted for the source context.
- **FR-010 — Ambiguity gate:** Conflicting or sub-threshold routing shall pause and require an authorized human selection.
- **FR-011 — Scope lock:** The selected tenant/client scope shall be immutable for a generation attempt and established before retrieval.
- **FR-012 — Wrong-client correction:** An authorized reviewer shall correct routing; downstream artifacts shall be invalidated and safely regenerated within the new scope.
- **FR-013 — Design brief schema:** The system shall produce a schema-valid Design Brief containing exact copy, locale, direction, format, requirements, assets, constraints, risks, and missing facts.
- **FR-014 — No invented facts:** The system shall never invent names, dates, prices, contacts, locations, legal claims, dimensions, or official slogans.
- **FR-015 — Exact-copy lock:** User- or client-approved copy shall be stored separately from model suggestions and compared byte/normalization-aware before approval.
- **FR-016 — Task route selection:** The system shall route work to template fill, editable AI composition, novel Creative Director workflow, or human-only design.
- **FR-017 — Client DNA:** Each client shall have versioned authoritative brand identity, language rules, assets, templates, permissions, folder mappings, approval policy, and prohibited elements.
- **FR-018 — Knowledge ingestion:** Authorized documents and visual examples shall be parsed, versioned, hashed, and indexed with provenance.
- **FR-019 — Curated ingestion scope:** Only explicitly approved client knowledge locations and files shall be indexed.
- **FR-020 — Hybrid retrieval:** Retrieval shall combine structured truth, exact/glossary search, PostgreSQL full-text/trigram search, multimodal embeddings, and reranking.
- **FR-021 — Client-first retrieval filter:** Every retrieval query shall enforce tenant/client and approval/version filters before similarity ranking.
- **FR-022 — Positive/negative separation:** Approved examples may be positive references; rejected designs shall be negative-only and include reasons.
- **FR-023 — Retrieval evidence:** Every Design Plan shall cite the exact rules, assets, examples, and feedback records used.
- **FR-024 — Private composition reference:** Novel designs may generate one private art-direction reference whose pixels shall never enter the shipped artifact.
- **FR-025 — Asset architecture:** The Creative Director shall select slot matrix, modular field, continuous scene, cutout stack, or layered collage before asset generation.
- **FR-026 — Independent visual assets:** Replaceable visual roles shall be generated or imported as independent assets when doing so preserves editability and quality.
- **FR-027 — Approved logos only:** Official logos shall be selected by immutable asset ID/hash and shall never be recreated by an image model.
- **FR-028 — Editable source:** Every automated graphic shall retain an editable structured source document with live text and independently addressable nodes.
- **FR-029 — Canonical creative document:** The accepted studio document and its content hash shall be the authoritative creative structure for a revision.
- **FR-030 — Studio adapter:** All business operations shall access the design engine through a versioned adapter contract.
- **FR-031 — Local edit preservation:** A user shall modify one text, image, color, crop, or layout node without regenerating unrelated content.
- **FR-032 — Design versioning:** Every saved revision shall create an immutable version record and preserve parent/child relationships.
- **FR-033 — Multi-format variants:** The system shall generate required aspect ratios as linked variants while preserving explicit per-variant overrides.
- **FR-034 — Sorani support:** The editor, renderer, QA, and review flow shall support Central Kurdish/Sorani script, punctuation, digits, fonts, and mixed-direction text.
- **FR-035 — Arabic support:** The editor, renderer, QA, and review flow shall support Arabic shaping, direction, punctuation, digits, and mixed Latin segments.
- **FR-036 — Language metadata:** Every text node shall carry locale, direction, canonical copy reference, and normalization policy.
- **FR-037 — Font management:** Authorized users shall upload/version client fonts; the system shall validate licensing metadata and glyph coverage.
- **FR-038 — Deterministic render QA:** The system shall validate schema, dimensions, file integrity, text overflow, clipping, glyphs, bidi behavior, safe zones, approved assets, and package completeness.
- **FR-039 — Visual QA:** An independent vision model shall score a fixed rubric and return evidence-linked findings without overriding hard checks.
- **FR-040 — Bounded repair:** Automatic repair shall run no more than two times per failed candidate unless a human explicitly authorizes another attempt.
- **FR-041 — Human review:** Reviewers shall inspect full-size output, exact copy, references, QA evidence, and revision differences before approval.
- **FR-042 — Structured revision:** A revision request shall identify scope, category, target nodes, priority, and whether the feedback is one-time or reusable.
- **FR-043 — Approval authority:** Only users with the configured client/project role may approve or reject a design.
- **FR-044 — Approval immutability:** Approval records shall be append-only and bound to an exact design/artifact hash.
- **FR-045 — Publication package:** Approval shall produce final formats, editable source, assets, brief, design plan, QC report, provenance, and approval manifest.
- **FR-046 — Deterministic Drive destination:** Drive IDs shall come from Client DNA; models shall not search for or choose destination folders.
- **FR-047 — Idempotent Drive upload:** A retry shall reuse or verify existing files by task/revision/output/content hash rather than create duplicates.
- **FR-048 — Publication verification:** The publisher shall read back file IDs, sizes, checksums/metadata, and permissions before marking completion.
- **FR-049 — Sheets upsert:** The reporting sheet shall be updated by immutable task ID and stored row identity, never blind-appended on retries.
- **FR-050 — Publication reconciliation:** A scheduled process shall compare PostgreSQL, Drive, and Sheet state and repair or flag divergence.
- **FR-051 — Thread notification:** The originating adapter shall receive status and final links when permitted; notification failure shall not roll back publication.
- **FR-052 — Feedback ledger:** Every correction, approval, rejection, and manual edit shall become a structured feedback event.
- **FR-053 — Rule proposals:** Repeated or explicit corrections may create scoped candidate rules with supporting evidence.
- **FR-054 — Rule governance:** Only authorized humans may activate, retire, or supersede a Client DNA rule.
- **FR-055 — Evaluation-case creation:** Important failures and accepted edge cases shall be promotable into regression datasets.
- **FR-056 — Model registry:** All model roles shall resolve through a versioned registry containing exact model ID, provider, parameters, limits, cost, policy, and evaluation status.
- **FR-057 — Model admission:** A model/prompt/tool change shall not become primary until it passes the defined offline evaluation and canary gates.
- **FR-058 — Model fallback:** Each critical model role shall have an evaluated fallback with explicitly allowed degradation.
- **FR-059 — Provider outage handling:** Provider failures shall pause, retry, fall back according to policy, or request human action without losing completed work.
- **FR-060 — Workflow recovery:** Every long-running task shall resume after worker/server restart without repeating completed non-idempotent side effects.
- **FR-061 — Manual workflow control:** Operators shall pause, resume, cancel, replay, or restart from an approved checkpoint with an audit reason.
- **FR-062 — Capacity control:** The system shall limit expensive model, GPU, render, and publication concurrency by office/client/task scope.
- **FR-063 — Operational inbox:** Hawa Desk shall show new, blocked, generating, review, failed, publishing, and completed tasks with actionable reasons.
- **FR-064 — Operations evidence:** A failed step shall expose sanitized inputs, outputs, attempts, error class, next safe action, and trace link.
- **FR-065 — AI tracing:** Every AI call shall record role, exact model, prompt version, tool/schema version, token/asset cost, latency, and trace ID.
- **FR-066 — Data minimization:** Only the minimum client context required by a model call shall leave the office, subject to client egress policy.
- **FR-067 — Local-only policy:** A client/project may prohibit all external model calls and route to local models or humans.
- **FR-068 — Prompt-injection boundary:** Message/document instructions shall not alter permissions, system policies, tools, client scope, publication destination, or approval.
- **FR-069 — Audit trail:** Security- and business-relevant actions shall be append-only, attributable, timestamped, and queryable.
- **FR-070 — Backup and restore:** The system shall create encrypted backups and prove restoration on a clean environment at the defined cadence.
- **FR-071 — Adapter health:** The system shall monitor sequence gaps, authentication state, webhook health, and last successful reconciliation per adapter.
- **FR-072 — WhatsApp isolation:** WAHA shall run under a dedicated account and network/service boundary with a kill switch and no authoritative state.
- **FR-073 — ComfyUI isolation:** Only allowlisted, pinned, scanned ComfyUI nodes/workflows shall execute; workers shall not receive office database credentials.
- **FR-074 — Upstream pinning:** Editors, workflows, model weights, and critical containers shall be pinned by immutable version/digest and upgraded only through compatibility testing.
- **FR-075 — Studio fallback export:** The system shall retain enough neutral manifest data and standard exports to migrate a design away from the selected studio.
- **FR-076 — Accessibility:** Hawa Desk shall support keyboard navigation, visible focus, sufficient contrast, semantic status, and reduced motion.
- **FR-077 — Search and history:** Authorized users shall search tasks, clients, copy, assets, feedback, and revisions without leaking other clients.
- **FR-078 — Office configuration:** Admins shall configure clients, projects, adapters, roles, model policies, folders, templates, and review gates without code changes.
- **FR-079 — Cost controls:** The system shall enforce per-role budgets, generation caps, and visible estimated/actual cost before expensive reruns.
- **FR-080 — Safe deletion:** Destructive actions shall use retention-aware soft deletion and preserve audit; permanent purge requires explicit privileged workflow.

## Non-functional requirements

- **NFR-001 — Reliability:** No acknowledged task event may be silently lost. Event processing is at-least-once with logical exactly-once effects.
- **NFR-002 — Availability:** Core office intake and review target 99.5% monthly availability on supported infrastructure; adapters may have lower independent availability.
- **NFR-003 — Recovery:** Target database RPO ≤15 minutes and core RTO ≤4 hours; restore drills must prove these targets.
- **NFR-004 — Performance:** P95 Hawa Desk task list ≤1.5 s on office network; P95 webhook acknowledgement ≤1 s; non-AI state transitions ≤2 s.
- **NFR-005 — Scalability:** Support 100 active clients, 100,000 tasks, 2 million knowledge chunks, 25 concurrent office users, and controlled GPU/API queues without architecture change.
- **NFR-006 — Security:** Least privilege, client isolation, encrypted transport, server-side secrets, protected admin interfaces, and auditable authorization are mandatory.
- **NFR-007 — Privacy:** Per-client retention and model-egress policy shall be enforceable and testable.
- **NFR-008 — Editability:** 100% of automated production designs shall have a valid editable source; flattened-only output is a blocked failure.
- **NFR-009 — Multilingual correctness:** All critical Sorani/Arabic golden cases shall pass exact-copy and native-speaker visual review before release.
- **NFR-010 — Portability:** Operational data exports to documented JSON/CSV/SQL; designs export as `.hyc` plus standard SVG/PDF/PNG and a source manifest.
- **NFR-011 — Observability:** Every task shall be traceable across ingress, workflow, retrieval, model, studio, QA, approval, and publication.
- **NFR-012 — Maintainability:** Core business logic shall be covered by unit/contract tests and kept independent of specific adapters, models, and editors.
- **NFR-013 — Upgrade safety:** No production dependency auto-updates; upgrades require backup, compatibility suite, canary, and rollback artifact.
- **NFR-014 — Determinism:** Given the same approved inputs and pinned deterministic steps, routing, validation, filenames, and publication identities shall be repeatable.
- **NFR-015 — Auditability:** Approvals, rule changes, permissions, publications, and operator interventions shall be immutable and attributable.
- **NFR-016 — Usability:** A trained office operator shall create, route, review, revise, and publish routine work without command-line access.
- **NFR-017 — Failure clarity:** Every blocked/failed task shall expose a human-readable cause and one safe next action.
- **NFR-018 — Cost efficiency:** Routine template tasks shall avoid image generation and deep models when deterministic operations satisfy requirements.
- **NFR-019 — Vendor independence:** Failure or retirement of one model/provider, messaging adapter, or studio shall not require rewriting business state or workflow.
- **NFR-020 — Data integrity:** Foreign keys, constraints, hashes, append-only ledgers, and reconciliation protect against plausible-but-wrong state.
- **NFR-021 — Accessibility:** Target WCAG 2.2 AA for the Hawa Desk operational UI.
- **NFR-022 — Internationalization:** UI strings and content metadata support English, Central Kurdish (`ckb`), and Arabic (`ar`) with direction isolation.
- **NFR-023 — Deployment simplicity:** The base office deployment runs on one protected server plus optional GPU worker; Kubernetes is not required.
- **NFR-024 — Testability:** All third-party adapters have contract fakes and deterministic fixtures; model quality is tested separately from workflow correctness.
- **NFR-025 — Evidence discipline:** Claims about third-party capabilities remain conditional until executable admission tests pass.

## Success metrics

| Metric | Pilot target | Mature target |
|---|---:|---:|
| Cross-client leakage | 0 | 0 |
| Duplicate logical tasks from replay | 0 | 0 |
| Wrong logo/dimension/exact-copy escapes | 0 | 0 |
| Explicitly mapped routing accuracy | 100% | 100% |
| Ambiguous routing safely gated | 100% | 100% |
| Routine established-template approval within one revision | Baseline measured | ≥85% |
| Novel-design approval within two revisions | Baseline measured | ≥65% |
| Sorani/Arabic critical golden cases | 100% | 100% |
| Workflow completion without technical operator rescue | ≥95% | ≥99% |
| Successful clean-host restore drill | 100% | 100% quarterly |
| Approved artifacts with editable source | 100% | 100% |

## Product stages

- **Proof:** validate the editor, RTL, exports, durable workflow, and model tournament.
- **MVP:** three clients, Telegram + Hawa Desk, routine formats, human approval, Drive/Sheet.
- **Pilot:** creative asset generation, Client DNA retrieval, feedback proposals, optional WAHA.
- **Operational:** more clients, richer templates, selective auto-approval, local-only client policies.
