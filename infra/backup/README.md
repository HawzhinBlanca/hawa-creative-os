# Backups: operator notes

| Script | What | When |
|---|---|---|
| `nightly_backup.sh` | Postgres dump (verified by a restore), the file store's packs; with `HAWA_RESTATE_BACKUP=on`, Restate's volume first | 03:30 every night (launch agent `design.hawa.nightly-backup`) |
| `restate-nightly.sh` | Restate's data volume, encrypted, into the same archive | run by the nightly job; can be run alone |
| `restate-restore.sh` | restores a Restate archive into a stack that is not production | the restore drill (below) |
| `restore_drill.sh` | restores the newest dump and its files into a scratch database | the 1st of each month, 05:00 |
| `backup_restore_drill.sh` | schema, RLS and seed parity (no data) | Sundays 04:00 |

## The nightly Restate backup (architecture programme 2.6, ADR-034)

Restate holds the request lifecycle's live state once Phase 2 is on: object state, journals, delayed
reminders, idempotency keys and the worker registrations. `restate-nightly.sh`:

1. throws the Telegram intake kill switch through Core's API (`POST /v1/ingress/channels/telegram/toggle`
   `{"enabled":false}`, called from inside the Core container with its operator token, so no token
   reaches the host); a switch the office had already thrown is left thrown;
2. waits up to 5 minutes for `sys_invocation` to show no `running` invocation;
3. stops the Restate container and tars `/restate-data` through a helper container of Restate's own
   image (read-only mount, no network, never pulled);
4. starts Restate, waits until it is healthy and serves `TaskWorkflow` (the registrations come back
   with the volume), then releases the switch;
5. encrypts the tar with the dump's cipher (`HAWA_BACKUP_ARCHIVE_KEYFILE`), checks it decrypts back,
   and writes `restate_<STAMP>.tar.enc` and its `.sha256` to the archive, keeping the newest
   `HAWA_BACKUP_ARCHIVE_KEEP` (14), like the dumps.

One line per night in `snapshots/backup.log`:

```
<time> RESTATE OK <STAMP> total_s=… drain=clean|timeout running_left=… drain_s=… down_s=… volume_bytes=… tar_bytes=… archive_bytes=… sha256=… kill_switch=thrown|found_thrown archive=…
<time> OK <STAMP> bytes=… … restate=ok|failed|off restate_s=…      (the nightly job's own line)
```

**Switching it on.** It is off until the lead turns it on after the deploy: add `HAWA_RESTATE_BACKUP=on`
to the `design.hawa.nightly-backup` launch agent's environment (`infra/ops/install_launch_agents.sh`
carries hand-added `HAWA_*` settings over), or run it once by hand:
`HAWA_BACKUP_ARCHIVE_KEYFILE=<passphrase file> bash infra/backup/restate-nightly.sh`.

**Why before the dump.** A restore of both then finds Postgres at or ahead of Restate, the direction
the lifecycle reconciles (`AHEAD`, PHASE2_DESIGN.md section 2.8). A failed Restate step never stops
the dump; the night is marked failed at the end.

**When the drain times out** it goes on (`drain=timeout`): stopping Restate is durable, a running
invocation resumes from its journal after the start (as after any restart, and as the chaos suite's
Restate kills show), and a night without a backup because one design ran long would be worse.

**Every path puts things back.** On an error, a timeout or a signal the script starts Restate if it
stopped it and releases the switch if it threw it. When Restate does not come back, or the switch
cannot be released, it prints a banner (`RESTATE IS DOWN` / `TELEGRAM INTAKE IS STILL SWITCHED OFF`),
logs `RESTATE FAIL`, alerts the operator's Telegram chat and exits 3; any other failure exits 1 with
the service as it was. A run killed outright (SIGKILL, a power cut) leaves
`~/.hawa/restate-backup.state`; the next run starts Restate and releases the switch it records before
anything else, and says so (`RESTATE RECOVER`). The watchdog skips its pass while a backup run is
alive (it would otherwise start Restate under the tar); the script refuses an archive if Restate was
started during the tar anyway.

What a night costs: Restate is down for the tar alone (`down_s`), Telegram intake is paused for the
drain plus that (`total_s` less the encryption). During that time a Desk action that needs Restate
(Deliver on a flagged chat, a redrive) fails and can be pressed again; outbox dispatches retry.

### What happens to a message sent while the switch is thrown

Checked in the code on 2026-09-25 (`studio-v2` at 1c1316d), and end to end by the drill below:
messages wait in Telegram and are handled after the release. None is refused to the sender.

- **Core polls (production today, `HAWA_TELEGRAM_POLLER=core`).** The poller asks Telegram for nothing
  while the switch is thrown (`packages/integrations/src/telegram-bridge.ts:303`, wired to the switch at
  `apps/core/src/app.ts:244`), and stops between updates of a batch it is handling (`:341`), leaving
  the offset before the rest, so Telegram keeps them (for 24 hours). An update caught between that
  check and intake gets intake's 503 (`apps/core/src/routes/telegram-webhook.routes.ts:52`), which
  `apps/core/src/services/polled-update-dispatch.ts` counts as one failed attempt and retries after
  the release; parking (which tells the sender) takes five counted attempts, and one backup adds at
  most one.
- **The worker polls (`HAWA_TELEGRAM_POLLER=worker`).** The poller reads the switch from Postgres before
  every poll and between updates (`apps/worker/src/lifecycle/telegram-poller.ts:121`, `:160`) and asks
  for nothing while it is thrown. An update already handed to `ChatInbox` gets intake's `INTAKE_PAUSED`
  (`apps/core/src/routes/lifecycle-internal.routes.ts:106`), which the worker treats as "wait", not as
  a failure (`apps/worker/src/lifecycle/core-client.ts:34`; `chat-inbox.ts:17-21`): Restate retries it
  until the release and it is never dead-lettered.
- **Webhook mode** (not used): the route answers 503 and Telegram delivers the update again later.

## The restore drill (monthly, into the chaos stack; never production)

```sh
npx tsx packages/testkit/chaos/run.ts --restore-drill
```

It builds the `hawa-chaos` stack from this checkout (only one may run on the machine; the driver takes
it down with its volumes afterwards), then scenario RD1 (`packages/testkit/chaos/chaos.test.ts`):

1. a request delivered through the Restate path (ChatInbox, TaskWorkflow, the Delivery workflow);
2. `restate-nightly.sh` against the chaos stack's own Core, Restate and volume (the same script as
   production, with `HAWA_RESTATE_PROJECT=hawa-chaos`); a brief is sent to another chat while its kill
   switch is thrown, and must get no answer until the release, then be delivered;
3. `restate-restore.sh` restores the archive into the chaos Restate, which rolls Restate back behind
   Postgres, the chat and Drive (it knows the first request, not the second);
4. after a quiet period nothing may have been sent again; then R1 runs on the restored copy and must
   hold every invariant of the chaos suite.

Everything the drill writes (archive, passphrase, log) stays in `packages/testkit/chaos/.run/restore-drill`
(gitignored); no alert can be sent from it. The design's `AHEAD` reconciliations belong to the
`RequestLifecycle` (slice 2.3); until it is merged the drill counts them (0) and cannot require them.

**Restoring production's archive.** Restate keeps its data under `/restate-data/<RESTATE_NODE_NAME>/`
and a server started under another node name starts empty (healthy, serving nothing): production runs
as `hawa-restate-prod-1`, the chaos stack as `hawa-restate-chaos-1`. `restate-restore.sh` refuses such
an archive before it stops anything; start the chaos stack with `CHAOS_RESTATE_NODE_NAME=hawa-restate-prod-1`
to restore one. That path has not been run yet: production has taken no Restate archive.
