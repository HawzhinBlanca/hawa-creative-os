# Runbook: Failed or Stuck Task

## Trigger

Task remains beyond its step budget, enters `failed_retryable`/`failed_operator`, or staff report no progress.

## Diagnose

1. Open task timeline and trace.
2. Confirm current immutable checkpoint and workflow invocation.
3. Read error class, attempts, budget, provider/studio/integration health.
4. Verify no external side effect succeeded with a lost response.
5. Confirm task/client/source revision has not changed.

## Safe actions

- transient/capacity: resume or retry same idempotency identity;
- provider outage: select an admitted fallback within client policy;
- invalid input: return to fact/brief review;
- studio revision conflict: reload current source, preserve both revisions, reapply scoped operation;
- publication ambiguity: run reconciliation, never upload blindly;
- unknown after one safe retry: pause and escalate.

## Prohibited

- manually editing task state in SQL;
- deleting workflow journals/evidence;
- creating a new task to hide the old one;
- bypassing QA/approval;
- changing client scope to make retrieval succeed.

## Close

Record root cause, operator action, resulting task event, and whether a regression/fault-injection case was added.
