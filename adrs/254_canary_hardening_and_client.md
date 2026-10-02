# ADR-254: Canary Hardening and the Canary's Own Client

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/hunt2-canary` (from production `1e0616f0`). Not deployed, not installed, not run against production.
**Requirements:** FR-071 (monitor adapter health), FR-055 (failures become regression checks).
**Changes a foundation:** no. No migration, no new dependency, no new paid call. A client pack and its seed row are added (data, ADR-127).
**Builds on:**
- ADR-127: client packs; Core adds their rows at start-up.
- ADR-235: "who is this design for?".
- ADR-240: the nightly live canary.

**Number:** 254, assigned by the lead.

## 1. Context

Bug hunt 2 (2026-10-02) reviewed ADR-240's shipped diff. It found six problems (R1–R6) and one setup blocker:

- **R1.** Update ids came from the UTC day and the turn. Restate keeps `tg-<id>` idempotency keys for 7 days. A second run on the same day replayed the first run's updates and always failed.
- **R2.** The canary and the nightly backup both started at 03:30. The canary waited only if `pgrep` already saw the backup at that moment.
- **R3.** With a canary configured, every send that named a task read Postgres first.
- **R4.** A quiet skip (not production, not configured) wrote `status: skipped`. The next counted skip then raised a false "two nights in a row" alert.
- **R5.** The deploy lock was exec'd into its command. Every process the command started inherited the lock and could hold it after the command ended.
- **R6.** `setting()` kept the quotes around a value: `HAWA_CANARY_CLIENT_NAME="Canary Test"` was read with its quotes.
- **Setup blocker.** ADR-240 §4 said to create the canary client in the Desk, but nothing can create a client: there is no route and no Desk form.

## 2. Decision

### 2.1 Update ids per run (R1)

An update id is `9e12 + the run's start second × 1000 + the turn` (`runUpdateBase`).
- Runs hold the deploy lock, so no two start in the same second.
- A run has fewer than 1000 turns; the run stops if it reaches 1000. So two runs' ranges never meet.
- Within a run, the ids are fixed by its start.
- They stay below the copy reader's 2^51 until the year 2100, and are far from real ids and the owner's test ids (8e9 + n).
- No new id can be an ADR-240 day id: those were below 9.0001e12.
- The message id is the same offset modulo 2e9, which stays below 2^31.

### 2.2 The backup (R2)

- The canary now starts at 04:30, an hour after the backup (launch agent, systemd timer, README).
- It still waits while the backup runs. It also counts the backup as running while something holds the archive lock exclusively (`<HAWA_BACKUP_ARCHIVE_DEST>/.restate-backup.lock`). Only the nightly backup takes that lock exclusively; restore drills take it shared.
- The check asks for a shared hold without waiting and lets go at once.
- The canary's launch agent carries only `HAWA_BACKUP_ARCHIVE_DEST` from the nightly agent. The systemd unit already reads `/etc/hawa/backup.env`.
- Known limit: a backup that starts (a catch-up at boot) during that one check could find the lock busy. The window is microseconds every 30 s, and only while a backup is already suspected.

### 2.3 The sink's task check, once per task (R3)

The sink no longer runs `isCanaryTask` for every message. It reads a task's intake chats once (`taskIntakeChats`: the `sourceChannelId` of its `task.created` commands) and keeps them.
- That command is written with the task and never changes, so a kept answer stays true. Up to 5000 tasks are kept, oldest out first.
- **Never kept:** a task with no `task.created` yet, and a failed read. So the sink still fails closed: an office alert about a canary task can never be sent because of a stale answer.
- An injected `isCanaryTask` (tests) is still called as before.

### 2.4 Quiet skips (R4)

A quiet skip writes `"quiet": true` and `"countedStatus"` (the last counted night's status). The "two nights in a row" check reads `countedStatus` through quiet records. A quiet night therefore neither counts toward the alert nor resets the count.

### 2.5 The deploy lock (R5)

`deploy_lock.py` keeps the lock on its own non-inheritable descriptor.
- It runs the command as a child, passes SIGTERM and SIGHUP on to it, and exits with the child's status (128 + the signal when a signal ended it).
- SIGINT has a no-op handler, so Ctrl-C still reaches the command, and the command does not inherit an ignored SIGINT.
- The lock ends with the command, not with a helper the command left running.

### 2.6 Settings as compose reads them (R6)

`setting()` removes one pair of matching surrounding quotes, single or double, and a trailing CR.

### 2.7 The canary's client

The client ships as the pack `packages/creative/assets/clients/canary-test.json`. Its row is in `db/seed.sql`, and Core adds the same row at start-up (`ensureClientPackRows`).

| Field | Value |
|---|---|
| Name | "Canary Test" |
| Code | `canary-test` |
| Id | `c1000000-0000-4000-8000-000000000099` (`CANARY_TEST_CLIENT_ID` in contracts) |
| Status | onboarding |
| Latin alias | "canary test" (the only one) |
| Bound chats | none |

- **Never designed for automatically.** `autoDraftAllowedFor` refuses an onboarding pack, so every night is unpaid, whatever `HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK` says.
- **No model consent and no Drive or Sheet.** It has no DNA (ADR-234), and a pack carries neither.
- **No bound chat,** so the canary's third brief is still asked "who is this for?".
- **Named only by its two words.** It is not named `canary`: Core's fallback matches a client's code as a whole word (`resolveSourceClient`), and "canary yellow" is a colour a brief can name. "Canary Test" is two words no real brief is likely to contain.
- **Never offered to an office member** as an organisation to choose (`knownClientNames`).
- **Script defaults.** With `HAWA_CANARY_CLIENT_ID` and `HAWA_CANARY_CLIENT_NAME` unset or empty, the canary script uses this client. The briefs then read "Could you design a Canary Test poster…" and "it's for Canary Test".

ADR-240 §4 is updated: setup is now the chat id, the allowlist, a deploy, one manual run and the agent install.

## 3. Consequences

- The canary can be re-run by hand on the same day.
- A failed backup check can no longer let the canary run while Restate is stopped for the backup.
- **Paid nights need further steps.** They need the pack set to `live` (with an approved DNA and its onboarding list emptied) and the $0.50 daily limit set in Settings → Spending. That is a deliberate later step. Core's live-canary test plays the paid night with KAAE standing in for a live canary client.
- **Desk lists.** "Canary Test" appears in the Desk's client lists, as any client does. Its tasks carry `canary: true` (ADR-240).
- **Deploy lock signals.** A deploy killed with SIGKILL now releases the lock while its command may still run. Before this ADR the command kept the lock. SIGTERM, SIGHUP and Ctrl-C reach the command as before.

## 4. Verification

| Test file | Count | What it covers |
|---|---|---|
| `scripts/test/live-canary.test.ts` | 15 (+1) | ids per run; a second same-day run against a deduping bot passes; the default client |
| `packages/testkit/test/live-canary-runner.test.ts` | 14 (+4) | the archive-lock wait, and a shared hold is no backup; quiet skips; quoted settings; the lock ends with its command |
| `apps/worker/test/canary-sink.test.ts` | 12 (+1) | intake read once per task; never kept unfound or failed |
| `apps/core/test/live-canary.test.ts` | 8 (+2) | see below |
| `packages/creative/test/client-packs.test.ts` | 19 (+2) | the pack, its seed row; "canary yellow" and "canary testing" name no client |
| `packages/testkit/test/host-scheduling.test.ts` | 8 | 04:30; the canary agent carries only the archive destination |

`apps/core/test/live-canary.test.ts` in detail:
- the stub night now runs with the shipped client;
- with a weekly allowance, the shipped client is never designed for, and all three requests are its own;
- its seed row exists, and it is never offered to the office.

**Red before.** Each behaviour file was reverted to `1e0616f0` while the new tests were kept:
- `live_canary.sh`: 3 of 14 runner tests fail;
- `deploy_lock.py`: 1 fails;
- `live_canary_lib.ts` day ids: 2 of 15 fail.

**Not run:** production, a live Telegram chat, a real Restate server, a Linux host's systemd.
