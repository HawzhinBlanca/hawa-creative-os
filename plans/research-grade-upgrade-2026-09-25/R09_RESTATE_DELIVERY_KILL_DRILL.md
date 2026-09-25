# R09 — isolated Restate delivery process-kill drill

**Date:** 2026-09-25. **Scope:** one request-owned delivery after a signed office action. The production `OfficeDecisionGateway`, private `RequestLifecycle`, and `Delivery` handlers ran on Restate 1.7.10 with the repository's worker SDK 1.17.0. Core, PostgreSQL, Canva, Drive, Sheets, and Telegram were synthetic fixtures in `apps/worker/drills/delivery-restate-harness.ts`. No production service or client was touched.

## Isolation and fault

- Restate image `ghcr.io/restatedev/restate@sha256:5cef318c0fb6ae2763316ea628b395bb36d2ee0be7690897acd54a11c353a1c9` ran in disposable container and volume `hawa-delivery-restate-drill-20260925`, with localhost ingress `18081` and admin `19071`. The handler listened on `19081`; the deployment URI was `http://host.docker.internal:19081` and Restate assigned `dp_15A2GsiWcTtGJCEKd78FfSp`. The private lifecycle methods were not exposed at public ingress.
- The driver opened a synthetic request, completed its draft and approved one synthetic file at revision 3. A valid signed Deliver action claimed revision 4 and started one Delivery workflow. Its prepare fixture returned one archived file and one confirmed Sheet row. The sender fixture acknowledged one requester file and one notice.
- The final Core fixture persisted a hash-bound result and then sent `SIGKILL` to the handler **before returning**. The synthetic final state file survived; the Restate container and volume stayed running. The handler restarted against the same fixture state, and Restate retried the interrupted final projection.

| Observation | Result |
| --- | --- |
| Claim writes / prepare calls | 1 / 1 |
| Requester file / notice keys | 1 / 1, unchanged after restart and exact action resend |
| Final Core calls / logical final writes | 2 / 1 |
| Recovered request read through Restate | `stage=delivered`, revision 5, one finish result |
| Exact signed Deliver resend | Accepted with the same delivery ID and revision 5; no new sender key |
| Changed action under the old signature | HTTP 401 |
| Direct public call to private `RequestLifecycle.deliveryFinished` | HTTP 400 |

The isolated state assertion passed after the resend: one claim, one prepare, two final Core attempts, one logical final write, one requester file and one notice. The disposable handler and Restate container were stopped, and the Docker volume was removed. The synthetic state and Restate log were kept only under `/private/tmp/hawa-delivery-restate-drill-20260925/` for this run.

## Interpretation and remaining proof

This demonstrates the actual Restate journal and lifecycle handlers replaying a killed delivery **at the final projection boundary** without a second synthetic send. It does not prove an independent PostgreSQL crash, a crash during Drive or Telegram's own external acceptance window, real provider idempotency/read-back, a clean-host Restate restore, or a requester receipt. The fixture's final Core write is an idempotent file, not the production PostgreSQL projection. R09 and the G2 end-to-end gate remain **in progress**; flags remain off.

## Reproduction outline

Create a disposable JSON state file with UUIDs for `requestId`, `taskId`, `revisionId`, `approvalId`, `actorId`, `approvalActionId`, `deliveryActionId`, and `artifactId`; initialize `claimWrites`, `prepareCalls`, `finishCalls`, `finishWrites` to 0, `senderKeys` to `[]`, `crashed` to `false`, and `crashOnce` to `true`. Set `HAWA_DELIVERY_DRILL_STATE` to that file, `HAWA_WORKER_TOKEN` to a synthetic secret, and `PORT=19081`, then run the harness. Start the pinned Restate image on separate ports and a fresh volume, register `http://host.docker.internal:19081` through admin `POST /deployments`, and invoke `DeliveryDrillDriver.prepare` through ingress. Sign a `deliver` office event with `signLifecycleOfficeEvent` using the same synthetic secret and invoke `OfficeDecisionGateway.decide`. Wait until the state file records `crashed=true`, restart the same harness without changing its state or secret, and read `DeliveryDrillDriver.read`. Resend the exact signed event and check the state counters, a tampered signature, and private ingress. Stop the handler/container and remove only the disposable volume. Use no real client data or provider credentials.
