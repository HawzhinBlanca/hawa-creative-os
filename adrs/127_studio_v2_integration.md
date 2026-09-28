# ADR-127 — Integrating studio-v2's remaining work into the mainline

Date: 2026-09-28. Status: implementation; items needing the owner are listed below.
Requirements: FR-070, NFR-003, NFR-013 (this checkpoint). Normative sources:
MASTER_SPEC.md, docs/10_WORKFLOW_RELIABILITY.md, runbooks/10_backup_restore.md,
adrs/053_guarded_single_node_restate_backup.md, adrs/054_fenced_intake_switch_release.md.

## Context

On 2026-09-28 the owner made `codex/research-grade-design-system` the mainline. Work
committed to `studio-v2` after the two branches parted (`1c1316d`) exists only there.
This ADR records how each part is carried over. Where the branches solve the same
problem differently, this branch's stricter guarantee is kept and studio-v2's intent
is fitted to it. studio-v2's RequestLifecycle (its waves 7 and 8, migration 023) is
superseded by this branch's own implementation (ADR-034, ADR-052, ADR-059 onward) and
is not ported.

## Decision: a Restate backup killed outright is put back by the watchdog

studio-v2's Restate backup was a shell script; its watchdog skipped a pass while a
backup ran and ran `restate-nightly.sh --recover` once a killed run's PID was gone
(088ce5e6, 4eb16341). This branch has its own backup (ADR-053 to ADR-057) and keeps
it. It restored Restate and the intake switch only in a `finally` block, which a
SIGKILL or a reboot never runs: Restate stayed stopped until the watchdog's generic
restart (which could also start Restate under a live cold copy), and intake stayed
paused with the pause revision lost, so nothing could release it safely.

Only the missing capability is ported, in this branch's structures:

- `--apply` writes an owner-only run record before each change: `switch`
  (`none`, `pausing`, `paused` with the returned `changeTag`) and `restate`
  (`running`, `stopping`). A cleanly finished or cleanly failed run removes it.
- Liveness is the archive lock (ADR-053; held for the whole night since ADR-081),
  not a PID: a process's `flock` ends with the process, however it ends, and a PID
  can be reused. Without a record, `--recover` returns before touching the lock.
- `--recover` does nothing while any backup holds the lock. Otherwise it starts
  Restate and waits for health if the record says it was stopped, then releases the
  intake pause only through ADR-054's conditional release with the recorded
  revision. A conflict means an operator decided later; the switch stays theirs.
  A `pausing` record (killed between Core's answer and the write) is never a
  release: it is reported until the office releases intake itself. Any failure
  keeps the record for the next pass.
- The watchdog runs `--recover` first on every pass and skips the pass while a
  backup is alive; `--status` uses the read-only `--recovery-status`. The next
  `--apply` performs the same recovery before it records anything of its own.
- A record held under a live lock for over two hours is reported as a stuck
  backup; that pass then continues as before (it may start Restate).

## Consequences and limits

- Verified with a real SIGKILL of a child process in the middle of the archive
  step against a file-backed fake engine, and with the watchdog run against stubbed
  Docker, curl and sleep. No production Docker engine, Core, PostgreSQL or Restate
  was contacted. The production backup schedule remains off (ADR-053).
- A kill between Core's pause answer and the record write leaves an unreleased
  pause the office must release; this is deliberate refusal rather than a guess.
- The watchdog's `notify` no longer ends the pass with exit 2 when the production
  environment file is absent (the guard `nightly_backup.sh` already had).
