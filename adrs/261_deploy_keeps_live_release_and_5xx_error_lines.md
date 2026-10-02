# ADR-261: A Deployment Keeps the Live Release; a 5xx Is an Error Line

**Date:** 2026-10-02
**Status:** Accepted (branch `claude/hawzhin-support`; not deployed — the next combined release carries it)
**Requirements:** NFR-012 (reproducible releases), NFR-006 (operability)
**Related:** ADR-158 (release directories, rollback = previous release), ADR-240 (deploy lock)

## Context

Two agents (Claude, Codex) develop and deploy to the one production host. On 2026-10-02 Codex put 23c28392
live between two of Claude's deploys; Claude's next candidate did not contain it and was stopped only
because a manual check (`readlink ~/.hawa/current`) happened to be run. The deploy lock (ADR-240)
serialises deploys but does not stop one from replacing a release with work the candidate lacks.

The 2026-10-02 operations review also found that Core wrote no error-level log line in two days, although
routes answer 500 themselves after catching (12 such sites); a count of error lines did not count failures.

## Decision

1. `hawa_deploy_keeps_live` (infra/ops/release_lib.sh), called by `deploy.sh` for pre-flight and `--apply`
   alike: the live release's commit (`~/.hawa/current`) must be an ancestor of the candidate. Allowed
   otherwise: the same commit; the previous release (`~/.hawa/previous`, the ADR-158 rollback); or
   `HAWA_DEPLOY_ALLOW_NON_DESCENDANT=1` set on purpose (warned). A first deploy (no live release) passes; a
   live commit the repository does not have is refused ("fetch it and merge it").
2. Core's request logger writes any 5xx response at error level. The message stays `request`, because
   `scripts/load/load-stats.ts` and the request-log tools select request lines by it.

## Consequences

- A stale or sideways candidate is refused before anything changes, with both commits named. Rollback is
  unaffected. The override exists for a deliberate, recorded exception.
- Error-level counts now include every failed request, so a nightly count or an alert on them is meaningful.

## Verification

- packages/testkit/test/release-directories.test.ts: +4 (first deploy, same, descendant pass; sideways
  refused naming both, then passes once merged; previous release and override pass with a note; unknown live
  commit refused) — 37 passed. Checked against real commits: this branch and Codex's 9bd9a7be pass; 23c28392
  is refused.
- apps/core/test/request-log-context.test.ts: +1 (5xx error, 4xx/2xx info, message unchanged); with the
  log-dependent suites (request-logs, access-log-judge-token, load export-chaos-logs) 16 passed.

## Addendum (2026-10-02): the office hears requests that wait for a person sooner

The same reality check found two waits nobody was told about:

- **A request opened for a designer** (auto-drafting off for the client, no client named, or a daily cap)
  told the requester "A designer will make …" and alerted no office member; it sat in the Desk until the
  24-hour stale sweep. `projectLifecycleOpen` now adds an office alert to every office member at once:
  the design's title, the client, and why nothing was drafted (`manualOpenAlert`). Holds and unallocated
  deliverables keep their own alerts. Test: apps/core/test/manual-open-office-alert.test.ts (3 + 1; they
  fail on the code before this change).
- **Reminders:** a draft in office review is now re-announced after 2 hours (was 24; the one delivered
  design waited 15 h overnight while its draft took 2 minutes), and a request for a designer after 8 hours
  (was 24). Still once per request per stage entry.

Queue cleanup (data, not code): the 52 RECEIVED and 4 AWAITING_APPROVAL Desk tasks from the 2026-09-11..20
test, pilot and audit runs were closed with the office cancel control and a stated reason; receipts in
output/handoffs/2026-10-02/CLAUDE_STALE_DESK_TASK_CLEANUP_RECEIPT.json.

## Addendum 2 (2026-10-02): an outside heartbeat

Alerts were sent through Telegram from the host they watched; a host that is off, asleep, locked at
FileVault after an automatic update, or offline said nothing. `hawa_heartbeat` (infra/ops/host_lib.sh)
pings `HAWA_HEARTBEAT_URL` (https only; from the environment or .env.production) on every healthy
watchdog pass; the outside dead-man's-switch service alerts the owner when the pings stop. Unset: nothing
is sent (today's state). Owner action: create the check (e.g. healthchecks.io, Better Stack), paste its URL
into ~/.hawa/shared/infra/docker/.env.production. Test: packages/testkit/test/heartbeat.test.ts (4).

## Addendum 3 (2026-10-02): the live-release check runs under the deploy lock

`deploy.sh` first ran `hawa_deploy_keeps_live` straight after the build-stamp check. That placement had two problems:

1. **It ran before the deploy lock (ADR-240).** A deploy that waited for another one judged the live release as it stood before that other deploy finished.
2. **It sourced `release_lib.sh` early.** The canary-runner test requires that file to be sourced only after the lock, so the test failed. A trial merge onto Codex's integration branch caught it.

**The fix:** the check now runs where `release_lib.sh` is sourced. That is after the host-role check and the lock, and before `hawa_release_prepare`.

A test in `release-directories.test.ts` pins this order. Pre-flight still runs the check too, because it uses the same path, without the lock.
