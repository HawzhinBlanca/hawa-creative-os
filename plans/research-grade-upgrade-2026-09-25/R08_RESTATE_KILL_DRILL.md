# R08 — isolated Restate process-kill drill

**Date:** 2026-09-25. **Source candidate:** `33a2fb2` plus `apps/worker/drills/office-restate-harness.ts`. **Scope:** the first authenticated office `revise` decision on a current round-zero draft. The production `OfficeDecisionGateway` and `RequestLifecycle` handlers ran with a synthetic Core projection; no production service, PostgreSQL table, Telegram chat, or Canva design was touched.

## Isolation and setup

- Restate ran in disposable container `hawa-office-restate-drill-20260925` with an independent Docker volume, localhost ingress `18080`, and localhost admin `19070`. Image: `ghcr.io/restatedev/restate@sha256:5cef318c0fb6ae2763316ea628b395bb36d2ee0be7690897acd54a11c353a1c9` (tag 1.7.10). Worker SDK: 1.17.0.
- The harness listened on port `19080`, with a synthetic Core state file under `/private/tmp/hawa-office-restate-drill-20260925/`. Restate registered `http://host.docker.internal:19080` as deployment `dp_15lnz9LPddu8usvKrX3l2xj`. The registration declared `RequestLifecycle` methods private and `OfficeDecisionGateway.decide` public.
- `OfficeDrillDriver.prepare` opened and completed a synthetic Canva draft at request revision 2, stage `in_review`. The signed action bound its action UUID, task, current design revision, expected request revision 2, authenticated office role and reason.

## Fault and observations

| Check | Observed |
| --- | --- |
| Changed payload under original signature | `OfficeDecisionGateway.decide` returned HTTP 401; no synthetic approval write. |
| First valid decision | Synthetic Core projection persisted `approvalWrites=1` and then killed the handler process with SIGKILL before returning. Restate logged `RT0010` and retried the same private `RequestLifecycle.officeDecision` invocation while the endpoint was down. |
| Restart | The same harness restarted on port 19080. Restate resumed the invocation; the original ingress call returned HTTP 200, `accepted=true`, request `rev=3`, `stage=manual`, with one approval ID. A state read independently returned `rev=3` and the same approval ID. |
| Exact signed resend | HTTP 200 with the same approval ID; `approvalWrites` remained 1. |
| Same action ID, changed reason, newly valid signature | HTTP 409; `approvalWrites` remained 1. |
| Direct ingress to private `RequestLifecycle.officeDecision` | HTTP 400, `the invoked service is not public`. |

The key observation is **one logical synthetic approval despite a real process kill between side-effect persistence and answer**. This exercises Restate journal replay and the handler's durable, hash-bound duplicate behavior. It does **not** prove that the real PostgreSQL Core projection survives an independent database failure, that an external provider effect is exactly once, or that Restate can be restored on a clean host. The original HTTP call completed after restart; no result was inferred solely from a later state read.

The fixed source tree passed **417 test files / 3,116 tests**, with **4 files / 48 tests skipped**, excluding only the unsealed release-manifest gate. Package, script and included-test TypeScript checks passed. Blueprint validation passed **745 / 0 / 0** after adding this drill. The release manifest and full sealed-tree suite are verified separately after the evidence commit.

## Reproduction outline

Run a disposable Restate 1.7.10 server on separate ports and volume, with its deployment URL pointing to a local `apps/worker/drills/office-restate-harness.ts` process. Give the harness a fresh JSON state file with `requestId`, `taskId`, `revisionId`, `approvalId`, `approvalWrites: 0`, `crashOnce: true`, and `crashed: false`; set `HAWA_OFFICE_DRILL_STATE`, a disposable `HAWA_WORKER_TOKEN`, and `PORT=19080`. Register its endpoint at the disposable Restate admin API. Call `OfficeDrillDriver.prepare`; sign an office event with `signLifecycleOfficeEvent` and submit it to `OfficeDecisionGateway.decide`. The first submission kills the harness. Restart it with the same state file and credential. Compare the original response, `OfficeDrillDriver.read`, an exact resend, a changed signed resend, and the state file's `approvalWrites`. Destroy the disposable container and volume afterward. Use only synthetic IDs, text, and credentials.

## Admission decision

**Pass for this narrow replay property.** R07/R08 remain **in progress**. A live office decision and production lifecycle cutover still require PostgreSQL-backed restart evidence, all authorization cases, later rounds, approval/delivery, provider receipts and the other gates in `PLAN.md`.
