# ADR-054: Fenced Intake Switch Release for Restate Backup

**Date:** 2026-09-25
**Status:** Accepted for local implementation; unattended production backup still needs a live rehearsal and clean-host restore proof.
**Requirements:** FR-060, FR-070, NFR-003, NFR-013.
**Sources:** `adrs/053_guarded_single_node_restate_backup.md`, `apps/core/src/services/channel-kill-switches.ts`, `apps/core/src/routes/ingress.routes.ts`, `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §2.6, inspected 2026-09-25.

## Context

The Restate cold-backup command throws the persisted Telegram intake switch and releases it after recovery. The existing toggle is a blind assignment. If an operator changes the switch while the backup is running, the backup could release it over that newer decision. A same-process lock on the backup command does not serialize an operator in another Core process.

## Decision

Every persisted channel switch write records a new opaque `changeTag` in the existing `integration_health.detail.killSwitch` object. The ingress toggle returns that tag. A caller may supply `expectedChangeTag` for a conditional toggle. Core applies it with one PostgreSQL `UPDATE ... WHERE detail.killSwitch.changeTag = expectedChangeTag` and returns conflict if no row matches. A normal operator toggle, even to the same state, replaces the tag and invalidates a backup's release. The backup command retains the tag returned by its pause and supplies it only when releasing its own pause. The tag is a revision marker, not an authentication credential; the route requires an authenticated office operator, administrator or art director.

The conditional write and ordinary upsert share PostgreSQL row locking and the existing per-process write queue. On a conflict, the backup cannot publish a successful archive manifest and reports the switch for operator review. An already-paused switch is never released by the backup.

## Consequences and limits

- Historical switch rows without a tag continue to work: the next ordinary write assigns one. A conditional write cannot match a missing tag.
- The backup still captures PostgreSQL, blobs and Restate at different times. Fencing the switch does not make a distributed snapshot or prove clean-host recovery.
- Local race tests and a disposable PostgreSQL rehearsal qualify only this conditional-release path. Production deployment and operator rehearsal remain separate gates.
