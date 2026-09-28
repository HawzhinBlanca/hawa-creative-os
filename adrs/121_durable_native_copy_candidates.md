# ADR-121 — Durable ownership of native text-copy candidates

Date: 2026-09-28. Status: implementation; native admission remains open.
Requirements: FR-029/032/042/060, NFR-001/020/024. Normative sources:
docs/05_CREATIVE_ENGINE.md, docs/10_WORKFLOW_RELIABILITY.md,
docs/11_QA_RTL_MULTILINGUAL.md, docs/30_CURRENT_STUDIO_CONTRACT.md.

## Decision

Use the existing Canva operation ledger for text-copy candidates. A current
RequestLifecycle manual revision may delegate candidate preparation to its office
human, under the existing request lock. The source comes from the saved parent
revision and same-client primary binding, not an arbitrary caller design ID.
The input pins task version, handoff basis hash, native timestamp and exact named
text. Read current source metadata/dataset and reject detected changes before
claiming. Provider timestamps do not establish native compare-and-swap.

Commit an immutable claim before POST. Freeze the actor, request/revision, parent
basis, text, title and dataset. Same-key replay checks the complete request digest;
different keys cannot create while a prior task creation lacks positive failure
evidence. No automatic replay of unknown sends. A returned job ID survives later
read failures and is reconciled through that actor's connection. Concurrent/late
reads cannot overwrite a completed receipt. Database guards preserve the admitted
identity, basis and acquired remote IDs.

Completion means only that Canva returned a separate candidate. It does not bind
the task, advance RequestLifecycle, confirm text/preservation or approve/publish.
Native preservation qualification is still open; expose no HTTP/Desk creation
route until that admission is complete. Existing manual confirmation and capture
can later consume a separately inspected candidate. Reconciliation may retain
an already-admitted effect after the request advances; it grants no new effects.

## Acceptance

Real isolated PostgreSQL and synthetic provider: claim precedes send, identical
and concurrent replay, new-key uncertainty refusal, safe known refusal retry,
fresh-service recovery, failed/stale/malformed reads, late competing observations,
request and parent basis changes, client/tenant/actor scope, immutable ledger
identity, and no implicit binding/task/review transition. Live account, actual
preservation, human judgment and release evidence remain separate gates.

## Local qualification — 2026-09-28

Migration 064 preserves claim inputs/identity, acquired job/design IDs and completed
status. The integration's pure preparation function validates before a claim;
native copy reconciliation joins task/client scope and the original actor. The
existing sweeper can reconcile submitted native jobs, retaining unknown outcomes.

Qualification uses restricted `hawa_app` connections, concurrent calls, a fresh
service/connection and injected database receipt-write failure after remote
acceptance. The connected suite passes 95 tests in seven files without skips.
Initial failures were two test expectations (PostgreSQL bigint revision is a string,
and the sweeper returns a wrapper). A separate two-case red run exposed a real
transport defect: non-success status could carry a created-design result and be
misread as positive failure. Such contradictory evidence now holds. HTTP 408 and
unclassified HTTP failures are likewise uncertain, not retry permission.

No live native call, automatic routing, HTTP/Desk creation surface, preservation
qualification, process-kill drill, deployment or whole-goal completion is claimed.
