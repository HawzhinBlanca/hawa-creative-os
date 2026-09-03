# Observability and Evaluation Operations

## 1. Stack

- OpenTelemetry SDKs and semantic conventions;
- self-hosted Arize Phoenix for AI traces, datasets, experiments, and evaluations;
- Restate operational UI/metrics for workflow journals and invocations;
- structured application logs;
- PostgreSQL operational/audit views;
- optional Prometheus/Grafana only when metrics volume/operations justify it.

## 2. Trace shape

One root trace per task/revision, with spans for:

```text
ingress
routing
brief extraction
Client DNA load
lexical/vector/rerank retrieval
creative planning
art-direction reference
asset generation/editing
studio operations
rendering
hard QA
visual judge
auto-repair
human wait/decision
Drive upload
Sheet sync
notification
feedback processing
```

## 3. Required AI attributes

- task/client IDs represented safely;
- role and exact deployment ID;
- prompt/tool/schema versions;
- input/output hashes;
- context source IDs;
- token/image/compute use and estimated cost;
- latency, retries, fallback reason;
- validation and guardrail result;
- evaluation tags;
- client egress policy.

Sensitive content follows retention/redaction policy and may be replaced by hashes.

## 4. Metrics

### Reliability

- lost/duplicate logical events;
- workflow success/retry/operator-rescue rate;
- state age and stuck tasks;
- adapter cursor gaps;
- publication divergence;
- restore drill results.

### Quality

- routing/brief exactness;
- critical QA escapes;
- approval/revision rates;
- manual edit distance;
- RTL golden pass;
- retrieval relevance;
- visual-judge precision/false blocks.

### Cost/performance

- cost per task/revision/client/task type;
- model and asset generation latency;
- GPU queue/utilization;
- context size;
- candidate/repair count;
- cache hit and fallback rates.

## 5. Alerts

Immediate:

- cross-client authorization anomaly;
- data-integrity/source-hash mismatch;
- repeated publication duplication attempt;
- backup/restore failure;
- WAHA account/session anomaly;
- unapproved ComfyUI node/workflow;
- critical model-regression canary;
- database/WAL backup failure.

Business-hours escalation:

- adapter stale/gap;
- stuck workflow;
- rising revision/QA-failure rate;
- provider cost spike;
- Drive/Sheet divergence;
- disk/GPU pressure.

## 6. Dashboards

- Office production health
- Review queue and aging
- Adapter health
- Model quality/cost by role
- Client quality trends
- Retrieval performance
- Studio/RTL regression
- Publication reconciliation
- Backup/restore readiness

## 7. Evaluation evidence

Phoenix datasets store references to sanitized cases and outputs. Final admission decisions remain in PostgreSQL/ADRs so observability tooling is replaceable.

## 8. Trace retention

High-detail traces may be retained briefly; metrics and hashes longer. Client-sensitive prompts/images follow the strictest applicable policy. Audit events are separate from observability and cannot be lost through trace sampling.
