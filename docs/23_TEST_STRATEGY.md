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

### Production's own data (ADR-137)

The test and chaos databases are built from `db/*.sql`, fixtures and synthetic scenarios; they hold
no production-shaped history. On 2026-09-28 that let a release pass its whole gate and then refuse
every paid call in production (ADR-133). Two checks close the gap; both read a production dump
file (`infra/backup/snapshots/predeploy_*.dump` from deploy.sh, or the nightly `hawa_*.dump`) and
never connect to production:

- **Release gate stage 3** (`scripts/enforce_release_gate.sh`, `packages/db/src/predeploy-dump-check.ts`):
  restores the newest dump into a scratch `hawa_drill_predeploy_*` database on the test server
  (`hawa-test-postgres`, 127.0.0.1:55432), applies the candidate's pending migrations with deploy's
  upgrader, and runs read-only invariants (`packages/db/src/predeploy-invariants.ts`): no daily
  spending scope `historyIncomplete` for any tenant or client; a zero-dollar admission accepted for
  every tenant, client and spending role; the runtime role reads under RLS; every `NOT VALID`
  constraint holds on the data; and schema parity with a database built from the checkout (nothing
  missing or different; extra production privileges are reported). The scratch databases are dropped
  on every exit path. About 10 s. The stage is skipped, with a message saying the migrations were
  not checked, only when no dump exists (a worktree has none; the gate runs from the main checkout).
  `--through <NNN>` replays a past release: on the 13:50Z dump of 2026-09-28, migrations through
  066 fail `budget-history` and `admission`, and through 067 pass.
- **Chaos suite on a copy of production** (`run.ts --seed-dump <file>`,
  `packages/testkit/chaos/driver/seed.ts`): the chaos Postgres is replaced by the dump, upgraded as a
  deploy does, stripped of stored credentials, and the scenarios run on it with every provider
  faked. The run refuses to start unless the egress fence holds from inside Core and the worker.

## 10. Acceptance evidence

Test runs store versioned artifacts, logs/traces, source hashes, screenshots, human sign-off, and defects. A green CI icon alone is insufficient for editor/model admission.
