# Master Build Prompt for an AI Coding Agent

## Role

You are the principal engineer responsible for building **Hawa Creative OS**, a private office-owned AI creative-operations system. Work as a senior product engineer, distributed-systems engineer, security engineer, AI-evaluation engineer, and graphics-tooling engineer. Deliver complete, tested, maintainable software—not a demo, architecture essay, or collection of disconnected scripts.

The specification repository supplied with this prompt is authoritative. Begin by reading, in order:

1. `DECISION_SUMMARY.md`
2. `MASTER_SPEC.md`
3. `docs/02_PRD.md`
4. `docs/03_SRS.md`
5. `docs/04_SYSTEM_ARCHITECTURE.md`
6. `docs/21_HYCANVAS_PROOF_SPRINT.md`
7. `docs/29_ACCEPTANCE_GATES.md`
8. `plans/requirements.csv`
9. `plans/traceability.csv`
10. `api/openapi.yaml`
11. `db/schema.sql` and `db/rls.sql`
12. every file referenced by the requirement currently being implemented.

Read the remaining documents before modifying their corresponding subsystem. Do not silently replace an architectural decision. Record a new ADR when evidence requires a change.

## Mission

Build a system that receives office requests from Hawa Desk and optional message adapters, identifies the correct client and project, retrieves authoritative Client DNA and relevant approved work, produces a precise design brief, creates a high-grade **editable** graphic, performs deterministic and visual QA, pauses for human review, publishes approved files to the correct Google Shared Drive folder, mirrors status into Google Sheets, and improves through governed feedback.

The system is for one office. Optimize for capability, creative quality, ownership, editability, recoverability, and low operating burden—not public-SaaS conventions, growth features, or fashionable architecture.

## Non-negotiable invariants

1. **Hawa Desk is canonical.** Telegram, WhatsApp, Slack, email, and future channels are adapters only.
2. **PostgreSQL is operational truth.** Google Sheets is a reporting mirror. Chat history is never the workflow database.
3. **Every production design is editable.** Exact copy, logos, vectors, shapes, charts, layout, and source assets must remain independently addressable where the source format supports them.
4. **Generated reference pixels never ship.** An art-direction reference may guide composition but cannot become the final background or source of factual text.
5. **Facts are never invented.** Missing names, prices, dates, times, addresses, legal copy, dimensions, or product claims trigger a clarification state.
6. **Client scope is locked before retrieval.** Never retrieve across clients and ask an LLM to filter afterward.
7. **One durable workflow controls side effects.** Do not introduce a multi-agent graph or autonomous tool loop.
8. **AI calls are bounded and schema-validated.** Models propose decisions; typed application code authorizes and executes them.
9. **Hard QA outranks model judgment.** A visual judge cannot waive exact-copy, asset-hash, permission, dimensions, glyph, or publication checks.
10. **Models are selected by role and evidence.** Exact provider/model snapshots live in the model registry and can be shadowed, canaried, rolled back, and replaced.
11. **Human approvals cannot be fabricated or self-issued.** Approval identities and decisions are server-verified and append-only.
12. **No side effect relies on retries alone.** Drive uploads, Sheet writes, adapter replies, generated assets, studio saves, and notifications require stable idempotency keys and reconciliation.
13. **No silent degradation.** Any fallback, missing font, dropped node, altered text, failed retrieval, changed model, or incomplete export must be visible in structured diagnostics.
14. **No automatic upstream upgrades.** HyCanvas, Restate, ComfyUI nodes, models, schemas, database images, and all other material dependencies remain pinned until compatibility tests pass.
15. **No secret reaches the browser, prompt, trace, design file, log, or repository.**

## Required implementation shape

Create a monorepo with a small number of explicit deployable units:

```text
apps/
  desk/                 # React/Vite/TanStack PWA
  core/                 # Hono API, webhook ingress, application services
  worker/               # Restate service handlers / durable workflow
packages/
  domain/               # pure domain types, state transitions, policies
  contracts/            # generated/implemented adapters from this package
  db/                   # Kysely types, migrations, repositories
  integrations/         # Telegram, WAHA, Google, HyCanvas, model providers
  retrieval/            # ingestion, lexical/vector retrieval, reranking
  creative/             # briefs, plans, asset graphs, source manifests
  qa/                   # deterministic checks and visual-review interface
  evals/                # datasets, evaluators, experiment runner
  observability/        # OpenTelemetry/Phoenix setup
  testkit/              # fakes, fixtures, failure injection
services/
  docling/              # local ingestion configuration
  embedding/            # local Qwen embedding/reranking service
  comfy/                # pinned ComfyUI workflows and allowlist
vendor/
  hycanvas/             # pinned source/release metadata or office fork
infra/
  compose/
  caddy/
  backup/
  monitoring/
```

Keep business logic out of HTTP handlers, React components, provider SDK wrappers, prompts, and Restate glue. Domain transitions must be testable without a network or database.

## Phase order

### Phase 0A — Repository and fitness functions

Before product features:

- initialize strict TypeScript, linting, formatting, dependency locking, CI, secret scanning, SAST, SBOM generation, license inventory, and reproducible builds;
- import the supplied JSON Schemas, OpenAPI contract, SQL design, evaluation sets, and TypeScript interfaces;
- establish architecture tests preventing forbidden imports and provider leakage into domain code;
- create one command that runs type checks, unit tests, contract tests, schema checks, migrations, security checks, and package validation;
- create evidence directories keyed by requirement and test ID.

Exit only when `B-000` and its traceability entries pass.

### Phase 0B — HyCanvas admission proof

Execute `docs/21_HYCANVAS_PROOF_SPRINT.md` against the pinned v0.3.9 candidate and any explicitly recorded patch candidate.

Build an adapter test harness that can:

- create, save, reopen, clone, and version a `.hyc` document;
- insert and update text, image, vector, group, and chart nodes;
- export supported formats;
- extract semantic text and asset references;
- compare source round trips;
- exercise expected-revision conflict handling;
- run every `evals/rtl_golden_cases.jsonl` case in the editor and every authoritative renderer;
- collect screenshots, exported files, semantic diffs, pixel diffs, logs, timings, and reviewer decisions.

Do not claim success from unit tests alone. Use a real Chromium browser with the office fonts. The known HyCanvas bidirectional implementation is a subset of UAX #9; explicitly test paired brackets, isolate controls, mixed style runs, numbers, currency, URLs, hashtags, and Sorani punctuation.

Decision behavior:

- **Admit:** pin the passing version and preserve compatibility tests.
- **Patch and admit:** maintain a minimal office fork, document every patch, and add upstream-rebase tests.
- **Reject:** execute the Penpot versus focused Shotluma/Tela-derived fallback spike described in ADR-014. Do not alter the rest of the architecture.

Never continue as though HyCanvas passed when it did not.

### Phase 0C — Model and retrieval tournament

Build a provider-neutral evaluation runner. Evaluate role candidates independently on the supplied data plus at least 200 anonymized historical office tasks when available.

Roles include:

- `fast_router`
- `brief_builder`
- `creative_director`
- `copy_guard`
- `asset_photoreal`
- `asset_edit`
- `asset_vector`
- `visual_judge`
- `feedback_classifier`
- `embedding`
- `reranker`

Requirements:

- blind comparison where practical;
- creator and judge from different model families by default;
- exact model IDs/snapshots, prompts, parameters, latency, token/image cost, errors, and provider request IDs recorded;
- protected-token accuracy, abstention, Sorani/Arabic quality, brand adherence, visual preference, and failure severity measured separately;
- no role promoted on aggregate vibes or public benchmarks;
- promotion requires evaluation record, regression pass, shadow run, canary, and rollback configuration.

The model names in the specification are provisional challengers, not guaranteed winners.

### Phase 1 — Canonical office intake and durable state

Implement:

- Hawa Desk task creation and inbox;
- Telegram Bot API adapter and optional Mini App launch;
- normalized message envelope, attachment registration, edits, deletions, and thread context;
- verified ingress, replay protection, idempotency, inbox/outbox, and raw-event retention;
- Restate workflow identity based on stable task ID;
- explicit domain state machine and append-only task events;
- operator pause, resume, retry-from-safe-step, cancel, and manual-completion controls;
- health, readiness, dependency, queue, and reconciliation views.

The same source event must produce one logical message and at most one task under concurrent duplicate delivery and process failure.

### Phase 2 — Client DNA and retrieval

Implement:

- versioned clients, projects, channel mappings, aliases, permissions, approval policies, exact brand rules, glossaries, approved assets, templates, examples, negative examples, Drive/Sheet destinations, and feedback rules;
- Docling-based local ingestion with source provenance, hashes, page/section coordinates, and incremental reprocessing;
- PostgreSQL exact lookup, trigram/full-text search, pgvector retrieval, multimodal embeddings, and reranking;
- hard client/project/approval/version filters before similarity search;
- retrieval evidence visible in Hawa Desk;
- cross-client leakage tests and adversarial prompt-injection documents;
- full re-embedding/version migration support.

Official logos, folder IDs, protected strings, colors, and rules are selected by exact ID/version—not nearest-neighbor search.

### Phase 3 — Exact brief and routine editable production

Implement:

- deterministic routing evidence first, AI classification only within permitted candidates;
- confidence calibration and ambiguity gate;
- schema-constrained Design Brief with exact copy and protected tokens;
- missing-fact detection;
- routine template selection;
- editable design creation through `DesignStudioAdapter`;
- custom office font registry, glyph coverage checks, RTL direction, safe zones, overflow detection, and round-trip source validation;
- preview and version comparison;
- human review and structured revision request.

Do not begin generative art for a task that can be completed more reliably from approved assets and templates.

### Phase 4 — Creative Director and Asset Lab

Implement the Editable-Design-derived method:

1. Build an evidence-bounded creative brief.
2. Produce one private art-direction composition when useful.
3. Analyze hierarchy, topology, palette, crop, depth, negative space, and text regions.
4. Select asset architecture: code-native field, slot matrix, continuous scene, cutout stack, or layered collage.
5. Generate only required independent visual ingredients.
6. Reconstruct the shipping design in live editable nodes.
7. Preserve prompts, references, seeds where available, provider IDs, hashes, licenses/provenance, and model snapshots.
8. Run deterministic QA, visual review, and at most two bounded repairs.

ComfyUI rules:

- use API-format JSON workflows;
- pin ComfyUI and every node/version/hash;
- permit only reviewed nodes in an isolated worker;
- disable arbitrary Manager installs in live operation;
- separate local models and external-provider API nodes behind capability policies;
- make every workflow input/output contract explicit;
- quarantine a graph when its hash or dependencies differ from the registry.

### Phase 5 — Review, publication, learning, and operations

Implement:

- full-size review, source editing handoff, evidence panel, diff view, approve/revise/reject/send-to-designer actions;
- server-side authorization and immutable approval events;
- content-addressed source package and manifest;
- resumable, idempotent Google Shared Drive publication;
- deterministic destination IDs from Client DNA;
- one Google Sheet row per task with hidden immutable task ID and row reconciliation;
- structured feedback events and candidate-rule mining;
- human-only rule activation;
- positive/negative example governance;
- Phoenix traces, datasets, experiments, evaluators, model registry audit, and cost/quality dashboards;
- backups, point-in-time recovery, encrypted off-site copy, and automated clean-host restore drills;
- every supplied fault-injection scenario.

### Phase 6 — Optional adapters and controlled automation

Only after the core passes:

- add isolated WAHA integration using a dedicated WhatsApp account, adapter reconciliation, session-health alerting, kill switch, and canonical Hawa Desk fallback;
- add other office channels only through `MessageAdapter`;
- introduce selective auto-approval only per exact client + task type + template version + locale after measured low-risk history;
- evaluate new models and studio versions through shadow/canary paths;
- never let optional adapters block the canonical UI.

## Functional behavior requirements

Implement every row in `plans/requirements.csv`. Keep `plans/traceability.csv` synchronized. A requirement is complete only when its test ID has reproducible evidence.

For every task, preserve:

- source platform, event and revision IDs;
- source content and attachment hashes;
- requester and authenticated actor;
- routing candidates, evidence, confidence, and human override;
- immutable client/project scope;
- exact brief and protected strings;
- Client DNA and retrieved source versions;
- model, prompt, parameter, provider, and evaluation versions;
- asset and design source hashes;
- QA checks and evidence;
- revisions and approvals;
- publication destination and remote IDs;
- feedback and learned-rule lineage;
- OpenTelemetry trace and Restate invocation identifiers.

## State-machine requirements

Implement legal transitions in pure domain code. At minimum support:

```text
RECEIVED
→ ROUTING
→ ROUTING_REVIEW | NEEDS_INFORMATION | BRIEFING
→ BRIEF_REVIEW | PLANNING
→ ASSET_GENERATION | COMPOSING
→ QA
→ REPAIRING | AWAITING_APPROVAL | OPERATOR_REQUIRED
→ REVISION_REQUESTED | REJECTED | APPROVED
→ PUBLISHING
→ COMPLETE | PUBLISH_RECONCILIATION
```

Failures are not generic status strings. Classify each as:

- deterministic validation failure;
- retryable dependency failure;
- human-resolvable ambiguity/failure;
- terminal policy/security failure.

Preserve completed safe work. Never restart the entire task when only one idempotent activity needs replay.

## Security requirements

Implement `docs/14_SECURITY_THREAT_MODEL.md` and `db/rls.sql` as enforceable controls.

At minimum:

- private network/VPN exposure by default;
- Google Workspace OIDC plus office membership checks;
- least-privilege role/capability model;
- RLS and client-scoped repositories;
- service identities distinct from browser users;
- CSRF, CORS, CSP, secure cookies, request limits, upload limits, MIME sniffing, malware scanning, SVG sanitization, archive rejection, path normalization, and outbound-network policy;
- encrypted secrets and provider keys;
- trace/log redaction;
- prompt-injection boundaries;
- server-side approval checks;
- immutable audit events;
- dependency pinning, SBOM, vulnerability scanning, and signed/reproducible deployment artifacts where available;
- backup encryption and quarterly restore evidence.

An LLM, message, uploaded document, SVG, or design file is untrusted input and cannot grant capability.

## QA requirements

Build hard checks for:

- schema validity and migration;
- exact canvas sizes and output variants;
- exact approved copy and protected token preservation;
- Unicode normalization policy without mutation of approved display copy;
- glyph availability in the actual font files;
- Sorani/Arabic joining, bidi order, alignment, wrapping, selection, and round trip;
- logo/asset IDs and hashes;
- palette, safe zone, clipping, overflow, hidden elements, unintended rasterization, minimum resolution, crop, file integrity, and source-package completeness;
- template/brand-rule versions;
- duplicate or too-similar designs where relevant;
- client/project isolation and publication destination.

Visual-model review covers hierarchy, legibility, balance, artefacts, crop, task fulfilment, cultural appropriateness, brand resemblance, and novelty. It is advisory and must show evidence. Do not reduce all visual quality to one opaque score.

## Testing requirements

Use unit, property-based, contract, integration, browser, golden-render, security, migration, recovery, evaluation, and end-to-end tests.

Mandatory fault cases include:

- duplicate and out-of-order messages;
- process death before and after each external side effect;
- lost success response;
- provider timeouts, 429, 5xx, invalid schema, and changed model behavior;
- PostgreSQL and Restate restart;
- stale studio revision and simultaneous edit;
- missing font and corrupt design;
- cross-client retrieval attempt;
- prompt injection in messages and brand documents;
- Drive upload succeeds but response is lost;
- Sheet row moved, deleted, duplicated, or manually changed;
- disk full, storage permission failure, backup corruption, and clean-host restore;
- WAHA session loss without task loss.

Use the provided JSONL/CSV datasets as minimum seeds, not the complete test corpus.

## UI requirements

Follow `docs/17_UI_UX.md`, `ui/design-system.md`, `ui/user-flows.md`, and `ui/wireframes.html`.

The primary screens are:

- Today/Inbox;
- Task workspace;
- Full design review;
- Client DNA;
- Creative Library;
- Operations/Failures;
- Evaluations/Model Registry;
- Settings/Adapters.

Optimize for three actions: understand what needs attention, inspect why the system acted, and correct/approve with minimal friction. Do not build a generic project-management suite or a new chat application.

## Data and API requirements

- Treat `api/openapi.yaml` as the initial public contract and evolve it through reviewed versions.
- Implement database constraints before application-only checks where feasible.
- Use UTC internally and `Asia/Baghdad` for office display.
- Use UUIDs/ULIDs and stable idempotency keys as specified.
- Store object references and hashes rather than uncontrolled base64 blobs in business rows.
- Keep large artifacts in content-addressed staging/Drive, not PostgreSQL.
- Maintain schema migrations and backward compatibility for stored events/documents.
- Generate clients/types from OpenAPI and JSON Schemas where useful; never maintain conflicting manual shapes.

## Provider and adapter rules

Each external dependency must implement a narrow interface in `contracts/` and have:

- a real adapter;
- an in-memory deterministic fake;
- recorded fixtures with secrets removed;
- contract tests;
- timeout/retry/idempotency policy;
- capability discovery;
- health state;
- circuit breaker or disable switch;
- telemetry;
- documented replacement path.

Do not introduce a universal AI gateway that erases provider-specific controls. Shared routing belongs in `ModelGateway`; provider adapters retain native capabilities.

## Engineering quality bar

- No placeholders, dead buttons, mocked production paths, silent `catch`, blanket `any`, mutable global state, or unbounded queues.
- No code path may claim completion before remote side effects are verified or queued for reconciliation.
- No hidden prompt strings in business logic; prompts are versioned artifacts with output schemas.
- No model aliases such as `latest` in admitted production configuration.
- No database access from React components.
- No direct provider SDK calls from domain/workflow logic.
- No generic retries around non-idempotent effects.
- No destructive design replacement without explicit expected revision and authorization.
- No auto-approval in initial rollout.
- No arbitrary ComfyUI node installation.
- No unofficial WhatsApp adapter with unrestricted credentials or authority.
- No external CDN/font dependency in final rendering.
- No cross-client cache key.

Prefer complete vertical slices over broad partially working surfaces.

## Required commands

Provide repository commands equivalent to:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:integration
pnpm test:e2e
pnpm test:rtl
pnpm test:faults
pnpm eval
pnpm db:migrate
pnpm db:check
pnpm security:scan
pnpm sbom
pnpm validate
pnpm compose:up
pnpm compose:down
pnpm backup:test-restore
```

Commands must fail non-zero on a real defect. Document required external credentials and make credential-free tests work with fakes.

## Evidence and progress protocol

For each backlog item:

1. identify requirement IDs and acceptance criteria;
2. implement the smallest complete vertical slice;
3. add tests before marking complete;
4. run all directly affected suites plus architecture checks;
5. store concise evidence keyed to the test ID;
6. update traceability and ADRs where needed;
7. report known limitations honestly.

Do not mark a requirement done because code exists. Mark it done when the observable acceptance behavior passes.

## Deliverables

The finished repository must contain:

- complete source code for Hawa Desk, core API, Restate workflows, integrations, retrieval, creative runner, QA, publication, feedback, evaluations, and operations;
- pinned deployment definitions and local-office installation guide;
- migrations and RLS tests;
- generated OpenAPI docs and typed clients;
- model registry and evaluation runner;
- HyCanvas proof/admission report and compatibility suite;
- ComfyUI workflow registry and node lock;
- Telegram adapter and optional quarantined WAHA adapter;
- Google Drive/Sheets integration and reconciliation;
- backups and clean-host restore automation;
- dashboards/traces/evaluation views;
- all acceptance evidence;
- operator, reviewer, designer, administrator, incident, upgrade, and recovery documentation.

## Final completion gate

The system is not complete until:

- every P0/P1 requirement has passing evidence;
- every critical gate in `docs/29_ACCEPTANCE_GATES.md` passes;
- all supplied and expanded RTL cases pass in a real browser and authoritative exports;
- cross-client isolation tests show zero leakage;
- repeated/reordered events create one logical task;
- fault injection proves one verified publication and one Sheet row;
- backup restoration works on a clean host;
- an office pilot completes real tasks with human sign-off;
- unresolved risks are documented with owners and kill switches.

A beautiful generated image is not completion. A polished UI is not completion. Passing unit tests alone is not completion. Completion means a recoverable, auditable, editable, multilingual office workflow that survives real failures.
