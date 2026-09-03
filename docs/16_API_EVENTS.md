# API and Event Design

## 1. API style

The office API is HTTP/JSON with OpenAPI 3.1. Long-running work returns a task/command identifier; state changes are observed through server-sent events, WebSocket notifications, polling, or adapter notifications.

Internal services use typed direct/Restate calls. External providers remain behind adapters.

## 2. Command endpoints

Representative commands:

```text
POST /v1/tasks
POST /v1/messages/{id}/promote
POST /v1/tasks/{id}/route
POST /v1/tasks/{id}/briefs
POST /v1/tasks/{id}/generate
POST /v1/tasks/{id}/pause
POST /v1/tasks/{id}/resume
POST /v1/tasks/{id}/cancel
POST /v1/tasks/{id}/replay
POST /v1/tasks/{id}/revisions/{revision}/qa
POST /v1/tasks/{id}/revisions/{revision}/decisions
POST /v1/tasks/{id}/publish
POST /v1/tasks/{id}/feedback
```

Every mutating endpoint requires an `Idempotency-Key`, authenticated actor, expected version where applicable, and a reason for privileged operations.

## 3. Query endpoints

```text
GET /v1/inbox
GET /v1/tasks/{id}
GET /v1/tasks/{id}/timeline
GET /v1/tasks/{id}/context
GET /v1/designs/{id}/revisions
GET /v1/clients/{id}/dna
GET /v1/clients/{id}/assets
GET /v1/clients/{id}/rules
GET /v1/operations/failures
GET /v1/evaluations/runs/{id}
GET /v1/integrations/health
```

Pagination is cursor-based. Search is authorization-filtered before ranking.

## 4. Event envelope

All domain events use:

```json
{
  "event_id": "uuid",
  "event_type": "task.brief.approved",
  "schema_version": 1,
  "occurred_at": "2026-09-03T12:00:00Z",
  "tenant_id": "uuid",
  "client_id": "uuid-or-null",
  "aggregate_type": "task",
  "aggregate_id": "uuid",
  "aggregate_version": 14,
  "actor": {"type":"user","id":"uuid"},
  "correlation_id": "uuid",
  "causation_id": "uuid",
  "trace_id": "otel-trace-id",
  "data": {}
}
```

## 5. Core events

```text
message.received
message.revised
message.promoted
task.created
task.routed
task.routing_blocked
brief.drafted
brief.approved
design.plan.created
asset.generated
design.revision.created
qa.completed
qa.failed
review.requested
approval.granted
approval.rejected
revision.requested
publication.started
publication.drive.completed
publication.sheet.completed
publication.completed
feedback.recorded
client_rule.proposed
client_rule.activated
model.deployment.changed
integration.health.changed
workflow.operator_action
```

## 6. Compatibility

- additive fields do not require a new event version;
- removing/renaming/changing meaning requires a new version;
- consumers ignore unknown additive fields;
- old versions are supported for a declared migration window;
- event samples and JSON schemas are contract-tested.

## 7. Error format

```json
{
  "type": "https://hawa.local/problems/revision-conflict",
  "title": "Design revision changed",
  "status": 409,
  "code": "DESIGN_REVISION_CONFLICT",
  "detail": "The design changed after this review was opened.",
  "safe_action": "Reload the current revision and review again.",
  "trace_id": "...",
  "errors": []
}
```

Never expose credentials, raw provider responses containing secrets, cross-client identifiers, or unnecessary prompt content.

## 8. Studio API boundary

Hawa Creative OS does not call arbitrary studio endpoints throughout domain code. It calls `DesignStudioAdapter` operations such as:

- create/import/open document;
- apply validated operation batch;
- get semantic manifest;
- render preview/export;
- verify round trip;
- get health/capabilities.

## 9. Model API boundary

Model calls include role, exact deployment ID, schema/tool version, client egress policy, deadline, and budget. Providers cannot be selected by user-controlled prompt text.

## 10. Webhook behavior

- verify signature/token before parsing attachments;
- enforce timestamp/replay windows where supported;
- cap request size;
- normalize and persist uniqueness;
- acknowledge only according to source timing and persistence guarantee;
- preserve source event ID and edit sequence;
- reject unsupported action/identity changes.

The full endpoint contract is in `api/openapi.yaml`; event examples are in `api/events.md`.
