# Durable Workflow and Reliability Design

## 1. Objective

Every acknowledged request must be recoverable. Every expensive or external step must be attributable. Replays must not duplicate tasks, model charges unnecessarily, editable documents, Drive files, or Sheet rows.

## 2. Restate model

Each task is a durable virtual object/workflow keyed by immutable `task_id`.

Suggested services:

```text
TaskWorkflow
RoutingService
BriefService
RetrievalService
CreativeDirectorService
AssetService
StudioService
QAService
ReviewService
PublicationService
FeedbackService
ReconciliationService
```

These are logical services and may run in one TypeScript worker process initially.

## 3. Ingress handoff

```text
verified webhook
→ INSERT message_event (unique adapter/source/event)
→ optional INSERT task
→ INSERT outbox command in same PostgreSQL transaction
→ acknowledge platform
→ dispatcher invokes/signals Restate with idempotency key
→ outbox marked delivered
```

This protects accepted work if Restate is temporarily unreachable.

## 4. Durable call policy

A Restate durable call wraps only operations with stable serialization and replay semantics. All side effects also have application-level idempotency.

| Operation | Idempotency identity |
|---|---|
| Logical task | normalized source event or direct task UUID |
| Model call | task + revision + role + prompt/schema/model/input hash |
| Asset generation | task + design-plan revision + slot + attempt profile |
| Studio operation | design doc + expected revision + operation ID |
| QC run | design revision hash + QC profile version |
| Approval | design revision + approver + decision nonce |
| Drive artifact | task + revision + variant + artifact hash |
| Sheet row | immutable task ID |
| Notification | task event + destination + notification type |

For new Studio calls, PostgreSQL admits a per-run ordinal and request digest before transport. A lost answer remains uncertain and cannot trigger a second paid request. On a completed call, the tenant-scoped ledger preserves the requested model separately from the provider-reported served model, provider request ID, response-content SHA-256, latency and attempt count when the adapter supplies them. Historical or absent receipt facts remain null. These fields support reconciliation but do not establish billing or permit response replay; raw prompt and response content are not kept in this ledger (ADRs 048–050).

The ledger seals a call's run/stage/model/ordinal/digest at admission. Its first outcome, including `uncertain`, is the last mutation allowed; a second finalization is a conflict and holds the Studio pipeline. Reconciliation must append separately attributed evidence rather than rewrite the original call (ADR-051).

Studio art admits each image attempt and each vision verification separately
(ADR-090). Verification uses the bounded structured text adapter and a runtime
validated verdict. All individual receipts consume call slots and contribute
known cost; the aggregate art result must not charge them again. Unknown provider
acceptance and failed local accounting hold the pipeline, including when a
procedural fallback could otherwise be rendered. A definite verifier failure may
select a visibly reported procedural fallback. Historical aggregate art receipts
are not rewritten to fabricate their missing verifier costs.

Run replacement cannot clear uncertainty (ADR-086). Under the task row lock, a
new Studio run or alternate planner reservation checks unresolved Studio calls
across every run for that task, including stale, failed and abandoned runs.
Abandonment shares this lock with paid-call admission. Closed runs refuse new
calls, while earlier admitted calls may still record their first late outcome.
Transferred runs retain only the existing content-keyed parity operation. This
prevents replacement from resetting an unresolved cost; it does not yet provide
general Studio settlement or replay of a lost response.

## 5. Retry classes

An uncertain request-owned Telegram send is never an automatic retry. Under ADR-046, an office administrator may record that every approved file and notice is visible in the immutable requester chat, using one message ID per item and an expected request revision. Core verifies the local marks and archived Drive/Sheet receipts and commits one audited settlement; inconclusive cases remain open. This is staff observation, not a requester read receipt or proof of exactly-once Telegram transport.

For outbound Telegram messages, a provider 5xx or HTTP success without a valid API result is an unknown external effect, including when it occurs on a formatting fallback. Do not classify it as a definite failure and repeat the send. A definite pre-connection failure or explicit 429 may retry under the existing per-message send mark and backoff policy.

The legacy outbox also requires a positive Bot API message ID and a committed `sent` mark before it completes a new Telegram message or approved-file notification. It retries a failed *local mark write* for a bounded period, then leaves the command uncertain and the earlier `attempted` mark in place. A later outbox requeue cannot repeat that send. Historical `sent` marks without IDs remain non-replayable and must not be upgraded to a fabricated receipt.

- **Transient:** definite pre-connection failure, 429, safe idempotent provider operations, lock contention — bounded exponential retry with jitter.
- **Capacity:** GPU queue/full, provider quota — durable wait or evaluated fallback.
- **Invalid input:** schema, missing asset, exact-copy conflict — no blind retry; request correction.
- **Policy:** client egress or permission denial — fail closed.
- **Permanent external:** revoked Drive permission, removed model — operator action.
- **Unknown:** reconcile first; retry only when the operation is provably safe, otherwise operator review.

## 6. Timeouts and budgets

Every step declares:

- attempt timeout;
- total workflow deadline;
- maximum attempts;
- cost/token/image budget;
- allowed fallbacks;
- cancellation behavior;
- compensation/reconciliation behavior.

No unbounded agent loop or open-ended polling is permitted.

## 7. Human waitpoints

Review is a durable state, not a sleeping process. The workflow waits on an approval signal tied to:

- task ID;
- immutable design revision;
- QC report hash;
- allowed decision set;
- approver authorization;
- expiry/escalation policy.

A stale approval signal is rejected.

## 8. Cancellation

Cancellation stops future work but does not erase evidence or blindly undo successful external side effects. The workflow records:

- requested by/reason;
- current checkpoint;
- in-flight operations;
- generated assets retained/deleted policy;
- publication state;
- any manual reconciliation required.

If cancellation commits while Drive upload is finishing, publication completion must check the task's current state and expected revision inside the receipt transaction. It must preserve the cancellation and withhold requester delivery. Because the file may already exist in Drive, the publication records an unconfirmed archive for audit and staffed retention review; a cancelled task must not be offered an automatic delivery retry.

Operator pause, resume and cancel require a reason, current expectedVersion and
stable Idempotency-Key. PostgreSQL commits the state and its attributable control
receipt together. Resume restores a retained operator pause checkpoint, not a
requester clarification state. A generic retry without a saved execution checkpoint
is refused; the operator uses the saved Studio/Canva run controls (ADR-078).

New design work is admitted under the task row lock (ADR-078). Studio checks each
paid-call reservation, including parity, using the authenticated actor's RLS scope.
Planner reservations, blank designs, new imports and candidate selections use the
same task eligibility rule. Closed, paused, approved/delivering and unknown states
refuse new work. Earlier admitted outcomes and import reconciliation remain
recordable after closure; no provider request already admitted can be undone by
this guard. An unresolved paid call remains a reconciliation requirement.

## 9. Recovery drills

Inject at least:

- API kill after event persistence;
- worker kill during model call, studio save, upload, and Sheet update;
- Restate restart during approval wait;
- PostgreSQL restart;
- duplicate/out-of-order adapter events;
- model timeout and malformed JSON;
- Drive upload success followed by response loss;
- Sheet update success followed by timeout;
- studio optimistic-concurrency conflict;
- GPU worker loss.

Expected result: one logical task, no unauthorized state change, no duplicate publication, clear operator action.

## 10. Operational controls

Hawa Desk exposes:

- pause/resume;
- cancel;
- retry failed step;
- replay from safe checkpoint;
- select evaluated fallback;
- re-run QC;
- reconcile publication;
- inspect sanitized evidence;
- quarantine adapter/model/workflow/editor version.

Every control requires a reason and emits an audit event.

### Health observations (2026-09-25 R02 slice)

An adapter's configuration, recent reachability, and successful paid operation are separate facts. Configuration or a closed local circuit breaker alone cannot establish `connected` or `paid_verified`. A disabled or never-run paid probe reports `unverified`; its last result becomes `stale` after twice the scheduled interval. Provider observations include their measurement time and the operator's next safe action. An unavailable measurement reports `unknown` and null counts, never zero activity.

The OpenAI probe is opt-in through `HAWA_BILLING_PROBE_ENABLED=on`; `HAWA_BILLING_PROBE_MINUTES` defaults to 30 and has a five-minute minimum. Each attempted billable call appends a versioned, tenant-scoped observation to PostgreSQL, bound to a SHA-256 fingerprint of the exact credential and model. Health reads the newest row and does not call the provider. A changed key/model, a disabled schedule, a missing row or an unsupported observation version cannot reuse an earlier success. An observation beyond twice the probe interval is stale; an unreadable observation is unknown. Provider response bodies, keys and configuration fingerprints are excluded from health responses. The integration list labels a recent completion response with positive token usage `paid_verified`; it proves acceptance of the test request, not the final design pipeline or an invoice amount. Other adapters still need their own durable reachability receipts.

The design funnel is evaluated per automatic task. A successful draft in the same period cannot hide an overdue task without its Canva binding. Recent or manual-only requests without drafts are still in progress. The monitor reports the oldest overdue task and task-weighted p50/p95 durations for each completed stage, with sample counts and nulls when no stage has completed. Reading health is side-effect-free; any operator paging must use a separate deduplicated sender.

### Legacy delivery cutover pin (2026-09-25, ADR-052)

Chat enrolment for the legacy Delivery workflow is sampled when a Telegram task is created and saved as its immutable `delivery_executor_pin`. Existing tasks migrate to `core`. A revision, question answer, reformat or reference task inherits the scoped predecessor's pin. Idempotent intake replay returns the original task and pin. The publish route and both effect claim paths use the stored choice; an already-started publication or queued send keeps its recorded executor. A lifecycle-owned projection records Restate ownership separately and refuses to claim a Core-pinned predecessor. Changing `HAWA_LIFECYCLE_CHATS` must never change an existing task's executor at Deliver.

This local rule has database-backed tests. Full ChatInbox handoff of old requests, deployed canary rollback, Restate backup and clean-host restore remain R10 acceptance work.

## 11. Availability design

The first office deployment can use one core server, but it must include:

- UPS and graceful shutdown;
- mirrored storage;
- automated service restart;
- health checks;
- PostgreSQL WAL/PITR backups;
- encrypted off-site backup;
- a tested clean-host restore procedure;
- optional warm spare configuration after pilot.

## 12. Logical exactly-once definition

The system is at-least-once internally. It achieves **logical exactly-once effects** through uniqueness constraints, request hashes, idempotency tokens, optimistic concurrency, read-after-write verification, and reconciliation. Documentation must not claim physical exactly-once delivery across the internet.

### Shared gateway uncertainty and evaluation holds (ADR-083, 2026-09-27)

A dispatched model request with unknown acceptance (including HTTP 408/5xx), or
an unusable successful response, must stop the current logical call. Another
provider's success cannot settle that request's cost. Return a non-retryable hold
with observed provider/model, attempts, HTTP status and bounded request-header ID;
unknown cost stays null. Exclude raw provider bodies and exception text. A definite
rate rejection may follow the authorized bounded fallback policy.

Evaluation batches must stop further model calls on this hold and distinguish
attempted failures from unexecuted cases. A stopped tournament has no aggregate
pass percentage and is not admission evidence. The current implementation enforces
this during one process; a durable evaluation-call ledger, restart recovery and
provider reconciliation remain required before qualifying resumable evaluations.

### Durable fixture evaluation recovery (ADR-084, 2026-09-27)

Fixture tournaments use the existing tenant-scoped eval_runs table and a per-run
ordinal call ledger. The action UUID, request hash, corpus/image/protocol/source
identity and first call outcomes are immutable. Save admission before transport;
replay only the retained scoring projection and gateway receipt metadata. Raw
prompts and free-text responses are excluded. This narrow fixture retention rule
does not authorize storing general client model output.

A repeated action returns or resumes its saved run. A pending or uncertain call
holds the run and blocks fresh actions until reconciliation; provider availability
changes cannot bypass the saved admission. A version conflict requires the original
candidate. Database unavailability must not invoke an in-memory model path. Desk
retains the action through HTTP failure/refresh and exposes incomplete status and
sanitized call receipts. Provider settlement and live billing remain unqualified.

### Attributed closure of held fixture runs (ADR-085, 2026-09-27)

A named office administrator may close a held fixture evaluation by recording the
exact observed ledger snapshot and terminal provider evidence for every unresolved
call. The provider/support reference, retained-evidence digest and known reported
final cost are separate administrator attestations; they do not replace the original
unknown outcome or establish automated invoice verification. Unknown cost or
acceptance remains held. A confirmed non-acceptance requires zero cost.

Settlement is append-only, tenant-scoped, keyed and transactionally authorized. It
refuses an active execution or changed snapshot. The old report and call outcomes
remain unchanged, closed runs admit no new calls, and the settlement sends no model
request. Any subsequent evaluation is explicitly requested new billable work. See
runbooks/EVALUATION_RECOVERY.md. Automatic provider lookup and general Studio reply
recovery remain separate work.

### Stopped Studio call settlement (ADR-087, 2026-09-27)

A named office administrator may append terminal provider evidence and known final
reported cost for all unresolved calls in a stopped Studio run. Task/run/call locks,
current authority, an exact snapshot and a stable action protect the operation.
Original call outcomes, run budget/status and RequestLifecycle ownership remain
unchanged. Settlement sends no model request and cannot supply a lost design result.
New generation remains a separate action; evidence covers exact calls, never future
parity requests. Earlier admitted calls may still record a late first outcome.
See runbooks/STUDIO_RECOVERY.md. Administrator attestation remains distinct from
machine-verified provider billing and from human design approval.

### Cumulative Studio admission (ADR-088, 2026-09-27)

The task lock serializes budget evaluation and call insertion. Admission counts
all run call receipts, including distinct parity inputs after transfer; stale or
immutable run budget snapshots cannot reset limits. Exact-call settlement cost
counts once, conservatively retaining the greater of receipt and reported cost.
Malformed limits and incomplete historical accounting refuse dispatch. The USD
limit initially operated as a recorded-cost stop threshold. ADR-091 below extends
it with per-request reservations. Office/day/role limits remain additional work.
See runbooks/STUDIO_RECOVERY.md and R21_STUDIO_BUDGET_PROOF.json.


### Studio spending reservations (ADR-091, 2026-09-27)

Each newly admitted Studio request includes a versioned conservative quote bound
to the exact serialized transport body. Under the task lock, the repository adds
recorded/attested costs and outstanding reservations before admitting the next
quote. USD comparisons use micro-units. The immutable quote survives restart,
cancellation and lost replies. Missing usage or a per-image estimate retains the
unused reserve; complete valid usage, definite rejection or exact-call settlement
can release it. A higher observed charge remains in the ledger and blocks new
requests even below the run cap. Quotes are operating estimates, not invoice
ceilings. Historical calls retain absent reservation facts. No prompt or image
bytes are stored in the quote. Role/office/day budgets, live invoice qualification
and typed completed-stage replay remain separate requirements.

### Studio daily scope admission (ADR-092, 2026-09-27)

Migration 051 serializes Studio call admission, finalization, settlement and policy
revisions in PostgreSQL across all runs in an office. Each request must fit the
office, client and model-role daily caps as well as its run cap. Day boundaries use
Asia/Baghdad; unfinished and estimated obligations carry forward until exact
evidence releases them. New tasks, cancellation and process restart cannot reset
spend. Missing historical quotes on unresolved calls or a run snapshot ahead of its
ledger hold admission. Policy revisions and admitted policy/role identities are
immutable; trusted deployment-owner configuration uses expected revisions and action
IDs. See runbooks/STUDIO_DAILY_BUDGETS.md. Evaluation, voice and other paid paths
remain separate work before any app-wide spending claim.
