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

## 5. Retry classes

- **Transient:** network, 429, provider 5xx, lock contention — bounded exponential retry with jitter.
- **Capacity:** GPU queue/full, provider quota — durable wait or evaluated fallback.
- **Invalid input:** schema, missing asset, exact-copy conflict — no blind retry; request correction.
- **Policy:** client egress or permission denial — fail closed.
- **Permanent external:** revoked Drive permission, removed model — operator action.
- **Unknown:** one conservative retry where safe, then operator review.

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
