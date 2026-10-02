# ADR-261: A Deployment Keeps the Live Release; a 5xx Is an Error Line

**Date:** 2026-10-02
**Status:** Accepted (branch `claude/hawzhin-support`; not deployed — the next combined release carries it)
**Requirements:** NFR-012 (reproducible releases), NFR-006 (operability)
**Related:** ADR-158 (release directories, rollback = previous release), ADR-240 (deploy lock)

## Context

Two agents (Claude, Codex) develop and deploy to the one production host. On 2026-10-02 Codex put 23c28392
live between two of Claude's deploys; Claude's next candidate did not contain it and was stopped only
because a person-like check (`readlink ~/.hawa/current`) happened to be run. The deploy lock (ADR-240)
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
