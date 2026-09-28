# ADR-135: Every Telegram Request Takes the Lifecycle Path; the Old Path Only Finishes Its Own

**Date:** 2026-09-28
**Status:** Stage 1 implemented and locally qualified, not deployed. Stage 2 prepared as separate commits, to merge only when `GET /v1/operations/legacy-path` answers `stage2Ready: true`.
**Requirements:** FR-001, FR-004, FR-060, NFR-001, NFR-003, NFR-013.
**Changes a foundation:** ADR-052 (executor pin at creation: its chat flag is removed), ADR-059 (new-brief admission: no chat is left on legacy intake), ADR-129 (the Core poller as the rollback of the worker poller is retired). Builds on ADR-034.
**Map:** `plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT.md`.

## 1. Context

On 2026-09-28 the owner decided: "put everything on the new path, we don't need any other path, let's perfect this path." Production has run `HAWA_TELEGRAM_POLLER=worker` and `HAWA_LIFECYCLE_CHATS=*` since then.

Mapping the old path at `3f3d71ca` showed that the flag did not do what it said:

1. **New legacy requests were still created.** In a chat with any earlier Core-pinned task, an ordinary brief without `/new` went to legacy intake and became a new Core-pinned task (`hasLegacyTask`, ADR-059). Every chat that used the bot before the switch is such a chat; the owner's first test after the switch (task `dca13ce5`, 16:33Z) was a legacy task. Questions, greetings, standing rules and anything legacy intake's own classifier read as a brief also reached its "new request" stage.
2. **Replies to an open legacy draft were refused** as `STALE_REQUEST_REPLY`: they carry no lifecycle message link. ADR-059 meant them to stay on legacy intake.
3. **A legacy draft button could become a lifecycle revision.** A callback's data was read as message text, and in a chat with exactly one lifecycle request waiting for changes it was projected as that request's revision directive.
4. **Core's poller could not be a rollback.** It feeds only legacy intake, so rolling the poller back to Core (the ADR-129 procedure) would send every new request down the old path; runbook 20 already warned that lifecycle replies through it were never exercised.

The newest production dump (`predeploy_20260928T175243Z`, restored on the test server) holds 0 Restate-pinned tasks and 111 open legacy Telegram tasks in 15 chats (97 `received`, 12 `human_review`, 1 `paused`, 1 `failed_operator`; 110 untouched for four days).

## 2. Decision

**Stage 1 (ready to merge).**

- **Every Telegram chat is lifecycle-owned.** `HAWA_LIFECYCLE_CHATS` and `lifecycleOwnsChat` are removed. Treating unset as `*` was rejected: any other value (a list, an empty string set by mistake) would still send chats down the old path, and "no setting can do it" is simpler to hold and to test than "the default is right". Core logs the variable as ignored when it is still set. ChatInbox's `legacy` intake mode stays on the wire (a draining worker colour sends it for a chat's first update) and is answered exactly like `lifecycle`.
- **The old intake finishes its own requests and starts none.** It is reached only in a finish-only scope (`services/legacy-telegram-scope.ts`): when Core's internal intake hands it an update (header `x-hawa-intake-scope: finish-only`), and always in production, whoever calls the route. Updates go there only when they are about a legacy request (`services/legacy-telegram-routing.ts`): a callback query (lifecycle notices carry no buttons); a reply naming a legacy task of the chat; an unlinked message where the chat's newest request of the last 48 hours is an open legacy one (legacy intake's own reading window, `telegram-intake/replies.ts`). Questions, greetings and standing rules without a waiting request are still answered there. In that scope the route refuses its "new request" stage before it sends anything, and `persistChatIntake`, which writes every legacy task, refuses a Telegram task outside the lifecycle unless it continues an open (not complete, rejected or cancelled) legacy request of the same chat and not a lifecycle one. The refusal (`409 LEGACY_REQUEST_REFUSED`, reason `NEW_REQUEST`, `REQUEST_CLOSED` or `LIFECYCLE_OWNED`) becomes ChatInbox's existing `new-brief-required` notice: "send /new followed by the full design brief". `/new` always opens a lifecycle request. Every other brief opens one directly.
- **Core no longer polls, and the Core poller is not a rollback.** `telegramPollerOf` always names the worker, production options never start Core's loop, "Poll now" and webhook registration answer 409 (a webhook would bypass RequestLifecycle and stop the worker's getUpdates), compose defaults to `worker`, and `deploy.sh` refuses any other value before a backup or change, in pre-flight too. The worker still polls only with `worker`, so a stale `core` stops intake loudly (the watchdog alerts: Core's health names the worker) instead of routing it to the old path. A broken worker poller is rolled back with the worker: the previous colour (ADR-129 blue/green) or the previous release.
- **The lead can see when stage 2 may merge without SQL.** `GET /v1/operations/legacy-path` (administrators, read-only, one RLS-scoped transaction) answers the open legacy Telegram tasks by state and pin with the 50 least recently updated, Core requester sends still pending, legacy Delivery workflow runs in flight, the newest legacy task, and `stage2Ready`.
- Existing tasks keep their stored pin and executor (ADR-052). Desk, webhook and WhatsApp tasks are unchanged.

No migration: the pin, publication executor and receipts already exist. Migration 069 was not needed.

**Stage 2 (separate commits; merge only on `stage2Ready: true`).** Delete the Core poller and its rollback machinery, and the Delivery workflow's `reportTo: 'core'` path for non-lifecycle tasks. The finishing readers of the legacy intake cannot be removed cleanly yet, because the lifecycle path still delegates questions, greetings and standing rules to the same route; the written plan is in the map, section 6.

## 3. Consequences

- A chat whose newest request of the last 48 hours is an open legacy one needs `/new` for a new brief until that request is finished or 48 hours pass; everywhere else a plain brief opens a lifecycle request.
- The 111 open legacy tasks will not close on their own. Until the office finishes, rejects or cancels them, stage 2 waits and replies to them keep reaching legacy intake.
- A requester who replies to a finished legacy design, or presses "other size" on it, is asked for `/new` instead of getting a paid revision on the old path.
- Legacy intake's bilingual split (one graphic per language) has no lifecycle equivalent yet: an English-and-Kurdish brief opens one lifecycle request. Not changed here.
- Tests that build legacy tasks through `/webhooks/telegram` outside production keep working until stage 2.

## 4. Acceptance

Red run first, against the unchanged `3f3d71ca` sources with the new tests: 13 of 14 failed (every behaviour in section 1, the endpoint's 404, the backstop and the poller), 1 passed (a replayed event, which was already allowed). Results of the implementation, the updated suites and the chaos run are recorded in section 5.

## 5. Local qualification — 2026-09-28

- New tests: 3 files, 14 passed. Affected files together: 25 files, 321 passed, 2 skipped (the opt-in Core-kill drills for PDF sources and voice, which then passed separately with `HAWA_SOURCE_RECOVERY=1 HAWA_VOICE_RECOVERY=1`: 2 of 2).
- `pnpm run typecheck` (580 strict test roots) and `pnpm run lint` passed.
- Full suite (`HAWA_TEST_WORKERS=3`): 579 files; 4863 passed, 2 failed, 58 skipped. The webhook-registration test expected the 200 that ADR-135 now refuses; it was updated (6 of 6 then). The release-manifest seal test (`r11-release-gate` 1) fails on any source change until the release record is refreshed; RELEASE_MANIFEST.json was not edited.
- Production-shaped data: the newest dump counted on the test server (numbers in section 1); the scratch database was dropped.
- Chaos suite, worker mode, whole suite once (`run.ts --poller worker` at `9aedea64`, taken through the shared `hawa-chaos-lock`; 1091 s, peak 1365 MiB): 41 scenarios, **39 passed, 2 failed**. R1.K14 timed out: its second Deliver press went through the Desk helper, which waits for the request to be `approved`, and the request was already delivering. R1.S2.K5b expected the killed acknowledgement send to be uncertain and saw no office alert. Both expectations were corrected in `b3aceaaa` (the second press goes straight to Core and must start no second Delivery run; the expected alert follows the acknowledgement's own send marks). Targeted re-runs of the corrected scenarios: R1.K14 passed twice; R1.S2.K5b failed once more under the first correction (marks `[attempted, attempted, sent]` with one alert, where the correction expected none) and passed under the second (an attempt without a result expects one alert). In the last re-run R1.K0, which passed in the whole-suite run, ended `DESIGN_PLANNING`: since ADR-135 the acknowledgement and the design start together, so a 5 s Core kill during the acknowledgement can land in the design's planning; the plan stays `planning` and the run gives up after its 30 resume polls. Legacy intake acknowledged before the design started, so this was never exercised before. It is a lifecycle reliability finding, not fixed here, and R1.K0 is flaky until it is.
- An earlier attempt ran the chaos suite from a copy of the tree outside the repository (so stage 2 could be edited meanwhile); its setup hook hung for 30 minutes after starting Postgres, with no process or connection to show where. It is not counted; the run above is from the worktree itself.

Details: `plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT_PROOF.json`. Not executed: a deploy, a live Telegram chat, the load test (`scripts/load/run.ts` now refuses `--poller core` and was not run).
