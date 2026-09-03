# Domain Event Catalog

All events are immutable, versioned, and wrapped in the envelope documented in `docs/16_API_EVENTS.md`.

| Event | Producer | Key payload |
|---|---|---|
| `message.received.v1` | adapter gateway | normalized message ID, source, sender, attachment hashes |
| `message.revised.v1` | adapter gateway | prior/current revision IDs and changed fields |
| `message.promoted.v1` | Hawa Desk/workflow | message ID, promotion evidence/policy |
| `task.created.v1` | API/workflow | source, title, requester, initial state |
| `task.routed.v1` | routing workflow/user | client/project, confidence, evidence, method |
| `task.routing_blocked.v1` | routing workflow | candidates/conflict/safe question |
| `brief.drafted.v1` | brief workflow | brief ID/version/hash, missing information |
| `brief.approved.v1` | user/workflow | exact brief hash and approver |
| `design.plan.created.v1` | creative workflow | plan ID/version/hash, topology, budget |
| `asset.job.started.v1` | asset workflow | slot, workflow/model version, request hash |
| `asset.generated.v1` | asset worker | asset ID/hash/provenance |
| `design.revision.created.v1` | studio adapter | source/semantic hashes, parent, author |
| `qa.completed.v1` | QA workflow | report hash, critical pass, findings summary |
| `qa.failed.v1` | QA workflow | blocking finding IDs and repairability |
| `review.requested.v1` | review workflow | revision/QC hash, stage, assignee, expiry |
| `approval.granted.v1` | user | approval ID, exact revision/QC hash |
| `approval.rejected.v1` | user | reason/categories/annotations |
| `revision.requested.v1` | user | target nodes/regions and preferred action |
| `publication.started.v1` | publisher | publication key/package hash |
| `publication.drive.completed.v1` | publisher | folder/file IDs and verification digest |
| `publication.sheet.completed.v1` | publisher | row key/hash |
| `publication.completed.v1` | publisher | final Drive/source links |
| `feedback.recorded.v1` | feedback service | category/scope/before-after evidence |
| `client_rule.proposed.v1` | rule miner/user | candidate rule, scope, evidence/conflicts |
| `client_rule.activated.v1` | Client DNA manager | rule/version/effective date |
| `model.deployment.changed.v1` | evaluator/admin | role, from/to state, evaluation evidence |
| `integration.health.changed.v1` | health service | integration, prior/current state, cursor/gap |
| `workflow.operator_action.v1` | operator | action, reason, checkpoint, actor |

## Ordering

`aggregate_version` is strictly increasing per task aggregate. Consumers reject gaps and request replay. Adapter event order is preserved as source evidence but does not override task event order.

## Idempotency

An event ID is globally unique. A command that caused an event uses a stable idempotency key; replay returns the prior command/event result rather than emitting a duplicate logical transition.

## Privacy

Events contain IDs, hashes, decisions, and minimum operational data. Large prompts, images, raw messages, and credentials are referenced through authorized storage rather than copied into every event.
