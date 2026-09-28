# Durable Workflow and Reliability Design

## 1. Objective

Every acknowledged request must be recoverable. Every expensive or external step must be attributable. Replays must not duplicate tasks, model charges unnecessarily, editable documents, Drive files, or Sheet rows.

## 2. Restate model

Native text-copy candidates (ADR-121) reuse the Canva operation ledger. The
current manual revision owner delegates preparation under its request lock;
the source comes from the recorded parent and immutable client scope. A claim
precedes dispatch, acquired remote IDs cannot change, and uncertain or contradictory
responses remain unresolved. Reconciliation may retain a previously admitted
result after the request advances, but cannot create new work or advance review.
Native preservation and production routing remain separately gated.

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

ADR-111 adds a separate immutable, client-authorized result store. Validated
structured replies and image metadata/bytes commit atomically with the successful
receipt. Exact request digest, stage, provider and model must match before ordered
serial replay; saved content hashes must verify. Retained blobs are GC roots.
Replay does not spend again or consume another call slot, and current task authority
is rechecked. Unknown outcomes, missing/corrupt results, changed inputs and legacy
paid calls without reusable content remain held. Derivation pinning, branch-aware
substep replay and concurrent execution remain separate qualification. See
`runbooks/STUDIO_RECOVERY.md` and ADR-111 for the bounded recovery contract.

ADR-112 pins one visual basis before layout: upright photos, references, selected
examples, V3 conditioning thumbnails, cutout/shadow bytes and negative outcomes,
plus focus/sizes and available derivation hashes. All later stages consume the same
verified assets. Scope/task authority and current policy are checked again; no
retrieval or photo/cutout processing is repeated on reuse. Concurrent preparations
consume one committed winner. Old post-layout runs lacking a pinned basis hold for
review. Font/runtime identity and branch-aware substep replay remain separate work.

ADR-122 (migration 065) records a semantic substep, attempt and canonical binding
with every new Studio call. Recovery consumes retained results per substep in
attempt order, so a persisted rebrief branch or an interleaved image refusal no
longer holds retained work; a changed binding, an unreproducible failure before
retained work, an unknown outcome or a paid call without a result still holds.
Bindings add schema, capability policy, current authority (except artwork) and
the renderer/font basis where local rendering feeds the request. A persisted
rebrief continues from its stored form. The domain's `planStudioReuse` defines
explicit invalidation for keyed declared changes; no route declares one yet.

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

### Canva creation uncertainty (ADR-108)

An old or inaccessible Canva creation remains uncertain. Sweeping stops automatic
polling after the deadline and exposes a reconciliation hold; it never changes age
into proof of nonacceptance. A fresh import key can bypass a prior failed creation
only when that operation retains definite dispatch refusal/not-sent evidence or a
matching provider job's failed result, with no returned design. Historical failed
labels alone remain blocking and are displayed as unknown outcomes. Explicit resume
can reconcile the original job. Stale sweep/read results cannot demote a concurrently
completed operation. See `runbooks/CANVA_CREATION_RECONCILIATION.md`.

### General limits

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


### Shared gateway request spending (ADR-093)

The shared gateway freezes caller inputs/egress/budget, quotes the exact provider
body before dispatch, and enforces native output and cumulative elapsed-time caps.
A positive dollar allowance is a real pre-transport limit. Unpriced or unaffordable
work stops with a typed non-dispatched error; a reported overrun stops with its
known estimate and original quote retained. Unknown usage does not become zero
or a fabricated token count. Evaluation call outcomes persist this evidence and
replay it after restart. Application-wide durable admission for evaluation/voice
still requires integration with the Studio office ledger; a returned request quote
alone is not a database reservation.


### Schema-invalid paid evaluation replies (ADR-094)

Invalid response schemas stop before transport. Invalid provider answers preserve
known usage, exact request quote and response schema hash as a durable evaluation
hold; a fresh Core replays the saved failure without another paid call. Successful
scoring projections keep envelope provenance/schema hash separately from the
original answer hash. Historical receipts are unchanged.

### Shared office spending admission (ADR-096, 2026-09-27)

Migration 052 extends the Studio policy/lock to original evaluation and retained
voice ledgers. Evaluations reserve their full frozen request allowance against
office and model-role limits; voice reserves inspected audio cost against office,
client and voice-role limits. No duplicate balance counter is introduced. All
admission uses database timestamps, Asia/Baghdad days and READ COMMITTED queries
after the same office lock. Parent/task/source locks precede the spending lock.
Voice client identity also has a tenant/client foreign key; office-role permission
alone does not prove that an arbitrary client ID belongs to that tenant.

Complete finite usage or definite non-acceptance releases unused funds. Missing
usage, uncertain calls and received voice without billing evidence retain their
allocation across midnight. Missing historical allocation holds further spending;
an observed overrun remains recorded. Exact settlements preserve the greater of
observed and administrator-attested cost. Refused evaluations stop before transport;
refused voice preserves original audio and manual copy review. Original admission
and outcome identities are immutable; exact duplicate voice replay remains valid
after the allowance is exhausted.

This covers Studio, fixture evaluations and retained voice. Other provider-egress
paths, named policy administration/accounting repair, typed completed-stage replay,
fresh runtime qualification and live billing/office admission remain open. See
runbooks/STUDIO_DAILY_BUDGETS.md and R21_SHARED_SPENDING_PROOF.json.


### Exact-call cost evidence (ADR-097, 2026-09-27)

A named administrator can append snapshot-bound terminal cost evidence for an
exact Studio, evaluation or retained-voice call, including completed replies with
missing billing data. SQL verifies current authority, source identity, revision,
terminal evidence and the observed snapshot under parent/source and office locks.
Original receipts and all earlier attestations remain immutable. Shared daily and
Studio run admission retain the highest original, settled or attested cost; unused
reservations can then be released. A late receipt preserves any higher charge and
shows disagreement. Accounting does not clear execution holds or replay paid work.
Desk Operations shows paginated original costs, reserved amounts, attributed
history and conflicts. Unknown cost remains unknown; evidence files stay local.
See runbooks/CALL_COST_ACCOUNTING.md. Live billing, policy administration and typed
result recovery retain separate acceptance gates.


### Named daily budget administration (ADR-098, 2026-09-27)

Desk Operations exposes the existing shared office/client/role spending policy,
consistent current-day ledger usage and paginated revision history. Only a current
named administrator can append a policy after reviewing old and proposed limits
and supplying a reason. SQL checks session, tenant, actor, version and limits hash
under the same short lock as paid admissions. Runtime direct table writes remain
denied. The database records human identity separately from its connection identity;
historical owner revisions do not acquire fabricated human attribution.

Limits use nonnegative whole micro-dollars, including an explicit zero stop.
Removing a client or role override restores the displayed default. Lowering a cap
retains existing obligations; raising one never clears uncertain execution or
missing history. The fixed Asia/Baghdad day and current ledger accounting remain.
Desk retains an exact action scoped to the office and user before POST and retries
it after an uncertain answer or remount. Replay rechecks authority and returns the
original receipt before checking whether newer policy revisions exist. See
runbooks/SPENDING_POLICY.md. Other paid paths and live admission remain open.


### Source-bound fixture evidence (ADR-099, 2026-09-27)

Saved fixture reports identify corpus bytes by SHA-256 and individual cases as
passed, failed, not executed or unreported. Missing visual rubric scores cannot
be replaced by numeric defaults; incomplete scoring has no aggregate pass rate.
The replay protocol is v3. Completed legacy reports remain immutable and can
supply only their recorded aggregates, not reconstructed per-case outcomes.

Desk selects a saved run explicitly and matches case evidence to the exact corpus
identity. Dataset counts are measured from validated files, not fixture constants.
Browsing RTL definitions does not run the RTL corpus. Suite counts, call models,
latency and timestamps come from retained evidence. Candidate ranking, native
editability, canary results and human scores remain unknown unless independently
measured. Reading these views sends no generation request. Existing retained-action
retry, shared spending, and named settlement boundaries remain authoritative.


### Durable paid health probes (ADR-100, 2026-09-27)

Scheduled OpenAI health probes reserve their exact bounded request against the
shared office and `health_probe` role allowance before transport. PostgreSQL
serializes admission across Core instances and restarts, enforcing the longer of
the previous/current intervals and retaining uncertain calls across configuration
changes and midnight. Each attempt has a stable call ID, protocol, request hash,
reservation/policy version and one immutable outcome with actual receipt metadata,
latency and complete usage. Unknown facts remain null. Health GETs never dispatch.

Timeouts, ambiguous HTTP failures, invalid successful receipts, model mismatches
and bound overruns require reconciliation. A named administrator can append exact
terminal cost evidence through existing Operations accounting. After the interval,
this allows a new scheduled probe within current limits; it never replays the old
call or converts financial evidence into provider health. Original observations
remain immutable. Pre-ledger observations gain no fabricated costs. See
runbooks/PAID_HEALTH_PROBES.md and R21_PAID_HEALTH_PROBES_PROOF.json for qualification.

### Durable Canva planner calls (ADR-101, 2026-09-27)

Every planner request commits a quoted call under the shared office/client/role
allowance before dispatch. Its immutable outcome stores real receipt metadata,
complete native usage where reported, acceptance and uncertainty, and a typed
layout before source encoding. Same-key replay never pays again. A redrive prefix
or plan retirement cannot clear an unresolved charge or permit alternate Studio
spending. Named terminal cost evidence preserves the original outcome; it cannot
invent a result. Resume can reconstruct a retained layout without another model
call, rechecking task ownership, revisions and active references before import.
Historical unledgered plans remain incomplete accounting history. See
runbooks/CANVA_PLANNER_RECOVERY.md for operator actions and failure drills.

### Operations evidence authority (ADR-102, 2026-09-27)

Office intake/review availability targets 99.5% per calendar month. Without a
durable independent observation series, observed availability, compliance and
latency remain null. Fixture timings and local circuit breakers cannot establish
production availability. The synthetic operational execution endpoint is retired.

Operations uses the existing audited daily spending policy and original paid-call
accounting. Legacy monthly fixture-budget routes return 410; no sample balance or
monthly cap is converted into the daily ledger. Unknown telemetry stays unknown,
failed reads clear prior successful results, and late older refreshes cannot
replace newer evidence. Stored publication receipt audits show their scope,
timestamp and anomalies; no-task audits are empty, not proof of external storage
consistency. No audit claims to repair a drift or read live Drive/Sheets state.

Private API responses are excluded from service-worker caching. Activation purges
legacy Hawa API caches; Desk JSON requests use HTTP no-store. Offline shell/font
caching does not authorize replay of task, policy or health data from another
session or an older successful read (ADR-102 browser correction).

### Durable scoped receipt audits (ADR-103, 2026-09-27)

An audit action carries a UUID, exact authorized-scope hash, expected predecessor
and reason. Idempotency-Key must match the UUID. One serializable transaction reads
source facts and appends an immutable actor/scope revision; only bounded database
conflicts are retried. Replaying a committed action rechecks authorization and
returns the original result before checking the current predecessor. No provider
call or result broadcast occurs. Membership changes invalidate the prior scope
view; database failure cannot fall back to a process-local report. Current-revision
receipt lineage, artifact manifest matching and separately unconfirmed Sheet row
hashes prevent a false clean result. See runbooks/SCOPED_RECEIPT_AUDITS.md.

### ADR-104 — Independent minute observations

The dedicated collector claims a UTC minute in its durable transport spool before
probing the office edge, Desk assets, actual scoped storage operations (rolled back)
and current workflow/worker readiness. Append-only PostgreSQL observations bind the
monitor, target, slot and original UUID; replay returns the original content receipt.
Missing/interrupted time stays unknown. Calendar reports use Asia/Baghdad, expose
coverage and uncertainty bounds, and only evaluate monthly compliance on a completed,
fully observed month. Successful probe latency is not end-to-end user latency.
An independent physical host and real observation period remain admission gates.
See `runbooks/AVAILABILITY_MONITORING.md`; local mechanics are qualified in the
2026-09-27 `R02_AVAILABILITY_PROOF.json`. Real monthly admission remains open.
