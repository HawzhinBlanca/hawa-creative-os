# Deployment, Backup, and Disaster Recovery

## 1. Base topology

One protected office server plus an optional GPU worker.

### Core server

- Caddy
- Hawa Desk/API
- Restate server and workers
- PostgreSQL 18 + pgvector
- HyCanvas pinned service/binary
- Phoenix
- local content-addressed staging
- backup agents

### GPU worker

- ComfyUI
- local embedding/reranking services
- optional local image model
- no core database/Google credentials

## 2. Hardware baseline

Recommended core:

- modern 12–16 core CPU;
- 64 GB ECC RAM preferred;
- mirrored enterprise NVMe, sized for database + active staging;
- separate backup target;
- UPS with monitored graceful shutdown;
- wired network;
- encrypted disk where operationally suitable.

Optional GPU:

- 16 GB VRAM can support the smaller local retrieval/image paths serially;
- 24 GB+ gives more comfortable local 8B retrieval and creative workflows;
- local FLUX.2 Klein 4B is documented around a 13 GB VRAM class, but exact workflow use must be measured;
- do not buy hardware before the Phase 0 benchmark establishes the useful local workload.

## 3. Network

- private LAN/Tailscale for staff;
- Caddy TLS and host routing;
- only necessary public webhook endpoints exposed;
- PostgreSQL/Restate/HyCanvas/Phoenix private;
- service networks and egress policy;
- firewall and fail2ban/rate limits as appropriate.

## 4. Deployment artifacts

All images/binaries are pinned by digest/checksum. Configuration is versioned without secrets. Database migrations are explicit and backup-first.

Upgrade sequence:

1. read upstream changes/license/security advisories;
2. build candidate environment;
3. restore a production-like backup;
4. run contract, migration, RTL, editor, model, and publication suites;
5. snapshot/backup production;
6. canary internal users/tasks;
7. deploy;
8. monitor;
9. retain rollback artifacts.

## 5. Backups

### PostgreSQL

- WAL archive continuously;
- daily backup policy via pgBackRest;
- retention sufficient for operational and ransomware recovery;
- encrypted off-site copy;
- checksum/restore validation.

### Files/config

Restic backs up:

- editable sources/manifests not yet archived to Drive;
- staging metadata and active assets;
- ComfyUI workflows and model/checksum manifests—not necessarily huge model weights if reproducibly obtainable;
- deployment/configuration (without plaintext secrets);
- prompts/schemas/evaluation datasets;
- HyCanvas pinned binary/source compatibility artifacts;
- Caddy and service definitions.

### Google Drive

Drive is not the only backup of operational metadata. Approved source packages should also be covered by organization retention/export policy.

## 6. Recovery objectives

- database RPO target: ≤15 minutes;
- core office RTO target: ≤4 hours;
- adapter recovery may take longer without losing canonical tasks;
- GPU/AI generation may degrade to hosted or manual route.

## 7. Clean-host restore drill

Quarterly at minimum:

1. provision clean machine/VM;
2. restore secrets through approved process;
3. restore PostgreSQL to selected timestamp;
4. restore files/config;
5. start pinned services;
6. verify users/clients/tasks/source revisions;
7. open/render representative English/Sorani/Arabic designs;
8. resume a paused workflow safely;
9. reconcile Drive/Sheet;
10. document actual RPO/RTO and defects.

A backup is not considered valid until this drill succeeds.

## 8. Degraded modes

| Failed component | Degraded operation |
|---|---|
| Telegram/WAHA | create/review in Hawa Desk |
| external model | evaluated fallback/local/human route |
| GPU | external provider or queue/manual asset |
| HyCanvas | fallback studio/Chromium route; existing sources preserved |
| Phoenix | operations continue; audit remains in DB |
| Drive | approved work waits in local staging |
| Sheets | publication completes to Drive; report sync later |
| internet | local Desk, DB, studio, and local models continue where possible |

## 9. No Kubernetes

The office scale does not justify Kubernetes. Docker Compose/system services and a tested restore procedure are simpler and safer. Revisit only after measured multi-host operational need.
