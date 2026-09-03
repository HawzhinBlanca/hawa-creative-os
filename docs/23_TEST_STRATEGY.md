# Test Strategy

## 1. Test pyramid

### Unit

- schemas, normalization, state transitions;
- routing evidence logic;
- Client DNA rules;
- exact-copy token locks;
- filenames/hashes/idempotency;
- RTL/glyph checks;
- publication state;
- cost/budget calculations.

### Contract

- MessageAdapter;
- ModelGateway;
- RetrievalProvider;
- AssetProvider;
- DesignStudioAdapter;
- Publisher;
- QAEngine;
- Restate service interfaces;
- OpenAPI/event schemas.

### Integration

- PostgreSQL constraints/RLS/inbox/outbox;
- Restate recovery;
- HyCanvas adapter;
- ComfyUI allowlisted graph;
- Drive/Sheets sandbox;
- Telegram test bot;
- Phoenix/OTel.

### End-to-end

- direct task and Telegram task;
- ambiguous routing;
- routine template;
- novel creative route;
- manual edit and reapproval;
- publication retry/reconciliation;
- feedback/rule proposal;
- clean-host restore.

## 2. Deterministic versus model tests

Workflow correctness must be tested with deterministic fakes. Model quality is tested in frozen evaluation datasets. A nondeterministic model failure must not make core CI flaky.

## 3. Security tests

- RLS and API authorization matrix;
- cross-client ID guessing/search/vector access;
- prompt injection/tool escalation;
- signed URL expiry;
- upload/path/SVG/HTML abuse;
- WAHA/Comfy network isolation;
- secret/log redaction;
- approval/revision tampering;
- webhook replay/signature tests.

## 4. Fault injection

The full matrix is in `evals/fault_injection_matrix.csv`. Every external boundary gets before-call, during-call, success-response-lost, and after-call failure tests where meaningful.

## 5. Visual regression

- deterministic templates and RTL corpus have golden images;
- semantic text/node manifest is compared separately from pixels;
- anti-aliasing tolerances are declared by renderer/environment;
- critical copy/logo/layout regions use stricter checks;
- golden updates require reviewer approval and reason.

## 6. Model evaluation

- 200-task frozen corpus;
- blind pairwise creative review;
- exact programmatic checks;
- repeated stochastic runs;
- role-specific thresholds;
- cost/latency tracked;
- holdout retained;
- shadow/canary after offline pass.

## 7. Retrieval evaluation

- exact/rule/asset cases;
- semantic visual/style cases;
- Sorani/Arabic/mixed language;
- stale/deprecated/negative examples;
- adversarial cross-client cases;
- nDCG/Recall and downstream usefulness.

## 8. Performance/load

Office-scale tests:

- 25 concurrent users;
- 10 concurrent task workflows;
- controlled GPU/model queues;
- 100 active clients;
- 100k tasks and 2m chunks synthetic DB profile;
- large attachments/designs;
- sustained ingestion and publication reconciliation.

## 9. Migration/upgrade

For every database, HyCanvas, schema, browser, font, ComfyUI, model, or workflow upgrade:

- restore production-like backup;
- migrate forward;
- run compatibility and golden suites;
- exercise rollback/restore;
- verify old editable sources;
- verify audit and publication identities.

## 10. Acceptance evidence

Test runs store versioned artifacts, logs/traces, source hashes, screenshots, human sign-off, and defects. A green CI icon alone is insufficient for editor/model admission.
