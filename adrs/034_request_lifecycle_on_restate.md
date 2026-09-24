# ADR-034: The Request Lifecycle Runs on Restate; No Handler Waits for a Person

**Date:** 2026-09-24
**Status:** Accepted 2026-09-24 by the owner ("yes, do all"); implementation in progress (architecture programme, `output/plans/2026-09-24-architecture-programme/PLAN.md`, Phase 0.1 and Phase 2).
**Amends:** ADR-020's "one place produces the automatic draft: the Restate worker" (extended to the whole request); the worker deploy step in `infra/docker/deploy.sh`.

## 1. Context

Restate runs one step of a request's life (the design, `TaskWorkflow`). Everything else lives in Core's memory or in Postgres with a hand-made outbox and sweepers. On 2026-09-24 two review rounds found the consequences: a delivery stuck in PUBLISHING after a restart, Canva imports and studio runs nobody abandoned, outcomes lost when Core was down, clarification answers lost on restart, `act:` buttons dead after a restart, and Telegram updates processed one at a time for every chat (one 20 MB file held up the office for a minute). Core holds 24 stateful maps and cannot run a second replica.

Research into Restate 1.7 / TypeScript SDK 1.17 found a second problem in how the worker is deployed today:

- An invocation is pinned to the deployment that started it; a deployment is an address. `deploy.sh` re-registers the same address (`http://worker:9080`), with a `force: true` fallback, after replacing the container. In-flight journals then replay on changed code. Restate's error reference names this as the cause of journal mismatches (RT0016), and its admin API warns that `force` "can lead inflight invocations to an unrecoverable error state".
- Waiting inside a handler for hours or days (a workflow awaiting a promise until the office approves) pins that invocation to its deployment for as long; Restate's own guidance is to keep handlers short and hold long-lived state in Virtual Objects.

## 2. Decision

1. **No handler waits for a person.** Waiting is object state; each event (an answer, a decision, a finished design, a reminder) is a handler that runs for seconds. A deployment therefore drains within the longest single handler.
2. **Components:** `ChatInbox` (Virtual Object per chat: updates in order within a chat, concurrently across chats; the poller sends with idempotency key `tg-<update_id>` and advances its offset only after acceptance), `RequestLifecycle` (Virtual Object per request: the state machine), `DesignRun` (today's workflow, minutes long, reports and ends), `Delivery` (workflow per request and revision), `TelegramSender` (Virtual Object per chat, honouring `retry_after`). Reminders are delayed self-sends.
3. **Truth:** `RequestLifecycle` state decides a request's stage; Postgres is the projection the Desk reads, written through Core with an expected revision and a key `requestId:revision:step`. Desk and Core ask the object to change; they do not write the stage themselves.
4. **Deploys are blue/green:** two worker services, each registered at its own address; a deploy goes to the colour whose old deployment has drained (`SELECT count(*) FROM sys_invocation WHERE pinned_deployment_id = … AND status <> 'completed'` = 0), registers with `force: false`, and removes the drained deployment. The `force: true` fallback is removed. Handler payloads change only by adding optional fields; removed handlers stay as no-op shims while delayed sends still target them.
5. **Operations:** health reports paused and backing-off invocations and inbox depth; the Restate volume is archived nightly and restored monthly in a drill; the server is upgraded 1.7.0 → 1.7.10 and minor upgrades are tested on a copy of the data (the next minor migrates partitions one way).

## 3. Consequences

- A restart or deploy at any step no longer strands a request; the sweepers and in-memory recovery paths are retired (Canva operation reconciliation stays).
- Chats no longer wait for each other.
- Two worker containers run briefly during a deploy; memory is measured in Phase 0.
- The Restate volume holds live state and becomes as important as Postgres; every external boundary must be idempotent because a restore rolls state back.
- Migration risk is handled by a per-chat flag (the owner's chat first), cutover by creation date, and a chaos suite (`kill -9` of each process at each step, a deploy mid-request) as acceptance for every slice.

## 4. Alternatives considered

- **One workflow per request with durable promises for approvals.** The documented human-in-the-loop pattern, but it pins an invocation to one deployment for days, so every deploy would need the old worker alive for days.
- **Keep Postgres and the outbox, add more sweepers.** Each failure found this week got its own sweeper or patch; the pattern does not converge and keeps Core single-replica.
- **Temporal or another engine.** Restate is already deployed, journaled and understood here; no measured need to change engines.
