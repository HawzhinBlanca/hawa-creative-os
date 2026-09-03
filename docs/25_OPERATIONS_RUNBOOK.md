# Operations Runbook Overview

Detailed procedures live under `runbooks/`.

## Daily

- inspect blocked/failed task queue;
- verify Telegram/WAHA cursors and session health;
- inspect GPU/model provider capacity and budget;
- reconcile pending Drive/Sheet publications;
- confirm last database/file backup success;
- review critical security/integrity alerts.

## Weekly

- review quality/revision trends;
- examine repeated feedback/rule proposals;
- sample approved work and source packages;
- review provider/model fallbacks and costs;
- check disk/DB growth and staging cleanup;
- test one non-destructive workflow replay.

## Monthly

- patch OS/container dependencies through candidate environment;
- review users/roles/integrations;
- rotate selected credentials according to policy;
- audit ComfyUI node/workflow allowlist;
- export/check representative `.hyc` sources;
- evaluate new model candidates only when they address a measured gap.

## Quarterly

- clean-host database/file restore drill;
- full critical RTL/editor regression;
- fallback studio migration sample;
- incident/tabletop exercise;
- retention/deletion review;
- model and upstream-dependency architecture review.

## Incident priorities

### P0

Cross-client disclosure, source corruption, unauthorized approval/publication, credential compromise, unrecoverable database failure.

Immediate isolate, preserve evidence, revoke access, stop side effects, restore/repair through incident runbook.

### P1

Core intake/review unavailable, widespread workflow failure, Drive publication blocked, HyCanvas unusable for all tasks.

Activate degraded mode and recover within RTO.

### P2

Single adapter/provider/GPU failure, isolated task corruption caught before publication, Sheet divergence.

Use fallback/reconciliation and track root cause.

## Golden rule

Do not “fix” an incident by manually editing database state or deleting evidence. Use audited repair/reconciliation commands or a documented migration reviewed by another operator.
