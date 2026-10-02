# ADR-240: A Nightly Live Canary Plays the Telegram Request Path

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/nightly-live-canary` (from production `baffce10`); not deployed, not installed, not run against production. Owner-approved ("go ahead", 2026-10-01).
**Requirements:** FR-071 (monitor adapter health), FR-055 (failures become regression checks), FR-079 (budgets and generation caps), FR-005 (requester messages).
**Changes a foundation:** no. No migration, no new dependency, no new paid call. A deploy now holds a host lock (section 2.5).
**Builds on:**
- ADR-034: ChatInbox, TelegramSender and RequestLifecycle on Restate.
- ADR-155: office alerts to every member.
- ADR-158: release directories, and the watchdog's alert path.
- ADR-230: a requester's cancel withdraws a request.
- ADR-232: copy taken from a request's sentence.
- ADR-235: "who is this design for?".
- ADR-237: a design's cost.

**Number:** 240, assigned by the lead.

## 1. Context

On 2026-10-01 a person found 18 live defects (`LIVE_TEST_2026-10-01.md`, L1–L18) only by chatting with the bot. Synthetic updates were posted to Restate's `ChatInbox/<chat>/handleUpdate`, and the bot's answers were read from the journal. Every defect had passed its tests: the tests mocked a boundary that production does not.

Nothing in production plays that conversation again. A regression in intake wording, request targeting, the copy reader or the withdraw path would wait for a requester to meet it.

The manual method had three costs:
- it wrote to the owner's own chat;
- it alerted the real office;
- each automatic design was a paid round.

## 2. Decision

### 2.1 A chat no person can own

Telegram chat ids have at most 52 significant bits (Bot API), so no chat, private or group, is ever at or above 2^52.

- **The canary chat.** It is `HAWA_CANARY_CHAT_ID`, a whole number in [2^52, 2^53), which is still a safe JavaScript integer (`packages/contracts/src/canary.ts`).
- **Any other value configures nothing.** This includes the owner's chat id, a group id, or an id with a leading zero. It is logged and ignored. So a real chat can never be sunk, by a typo or by a copied id.

### 2.2 The sink: TelegramSender records, never sends

`sendAttempt` decides, before any send mark or Telegram call, whether a message is the canary's (`canarySinkFor`). It is the canary's when:

- it is addressed to the configured canary chat (`canary_chat`); or
- its task is one of the canary chat's requests (`canary_request`): the task's `task.created` intake names that chat. This is one indexed read, made only when a canary is configured.

Such a message is recorded and not sent:
- Telegram is never called.
- The step answers `{ outcome: 'canary_sink', messageId }`. The message id is a stand-in from the key, above 2^50. Restate journals that answer with the message, which is where the canary reads it.
- An audit row is appended under the message's own key (`telegram_<kind>_canary_sink`, with the words, the chat, the reason and `canaryFor`).

No reader of send marks takes `canary_sink` for `sent` (`MARK_KIND`), so a sunk message is never a requester's receipt:
- A delivery of a sunk file is refused (`CANARY_SINK`).
- A sunk question is not confirmed to RequestLifecycle, because Core would refuse a confirmation without a sent mark.

Without `HAWA_CANARY_CHAT_ID` nothing changes for any message.

`HAWA_CANARY_CHAT_ID` is added to the worker's allowlist (`prepare_service_boundaries.py`, ADR-163). The worker's outbox consumer applies the same rule to Core's own `notify.telegram` office messages (a stale request, an outcome Core could not record).

### 2.3 Office alerts about a canary request go to the sink

`SendResult` gains `canary_sink`, and `OutboundMessage` gains the optional `canaryFor`.

A request whose chat is in the reserved range is never the office's business. The worker's alert senders route its office alerts to that chat (`officeAlertRoute`), with `canaryFor` naming the member the alert was meant for. The senders that do this:
- ChatInbox's `alertOffice` (requester notes, late changes, questions);
- RequestLifecycle's draft alert (photo or text), its withdraw alerts, its early-hold and initial alerts, and its terminal-failure alerts, a failed open included;
- Delivery's failure alert.

The route is decided by the chat id alone, never by configuration, so a replay routes the same way.

Core sends no office alert of its own about a canary request:
- a parked update of the canary chat alerts nobody;
- `enqueueOfficeAlert` skips a canary requester.

The sink's task check (section 2.2) is the net under all of these.

### 2.4 Spending: at most one paid round a night, usually none

**Can the design run be stubbed? No.** A DesignRun reports a draft (`CANVA_DRAFT_READY_FOR_VISUAL_REVIEW`) only after:
- Core's Studio run;
- a Canva binding;
- a PNG and a PPTX export with its copy and font check;
- parity.

Core's design-outcome projection then verifies those receipts (`UNVERIFIED_DESIGN`). A stub would have to forge them, or skip the checks for the canary. Either way it would bypass the guards the canary exists to exercise. The live test's L13 showed what a mocked design boundary hides (ADR-113's native-revision guard).

**Instead, the admission guard itself decides.** `persistChatIntake` is where every automatic design is admitted:
- the first round;
- a requester's change round;
- a pending-change round (ADR-230 §6);
- an office retry.

There, a reserved-range chat has its own allowance: `HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK` (0–7, default 0; anything else is 0). It counts automatic designs over 6 days 12 hours, so a run at the same hour every night is admitted every seventh night.

- **0 (no paid round).** Every canary request goes down the real manual path: the same intake, copy reader, withdraw and office routing, with no paid call and no Canva write. The decline is the existing `SENDER_DAILY_CAP`.
- **1 (one real round a week).** The first brief of every seventh night is designed for real. Every later automatic design that night is a designer's:
  - the change sent while it is being made, which would otherwise start a pending-change round;
  - the second and third briefs.

**Hard cap.** The canary client's daily limit in the spending policy (`limits.clients[<canary client>] = 0.50`) is refused before admission by the existing ledger (migrations 067/071). A Studio run has its own $2 budget.

**Marker.** Canary tasks carry `canary: true` in their `task.created` payload, so the Desk and reports can leave them out.

**Measured cost** (ADR-237): a production-tier design with parity is about $0.17–0.22. A paid night is therefore about $0.17–0.22, every other night $0.00, about $0.03 a night on average. No night can pass $0.50.

**Model readings.** The canary client is left without model consent (ADR-234), so the copy reading and the intake router use the rules only. It makes no paid reading.

### 2.5 The canary and its schedule

**`scripts/live_canary.ts` and `live_canary_lib.ts`** play the night's conversation. Each line is a synthetic update posted to `ChatInbox/<canary>/handleUpdate/send` under `tg-<id>`. Update ids are `9e12 + day × 1000 + n`: new every night, far from real ids and from the owner's manual tests (8e9 + n), and below the copy reader's 2^51.

The canary reads back through Restate's admin SQL, from inside the Core container (the ports are not published):
- what the bot said: TelegramSender's journals, the message and its step's answer;
- each request: RequestLifecycle's `lc` state;
- the brief: RequestLifecycle `open`'s input.

It judges the stage and key phrases, never whole strings. The conversation, with a word of the night in every event's name:

1. "hi". This is the sink check: every reply must be `canary_sink`. Otherwise the night stops there, with the reason (HAWA_CANARY_CHAT_ID not set for the worker, or the chat not in TELEGRAM_INTAKE_ALLOWED_USERS).
2. Any earlier night's open request is withdrawn.
3. A brief naming the canary client. Checks:
   - one request opens, for that client, designing (paid) or with a designer;
   - the copy is taken from the sentence: the event's name as headline, the date on a line, no line that is the whole sentence, and a title that is not the raw sentence;
   - the reply names it.
4. "also please add that seats are limited", sent mid-design: acknowledged for that design, nothing opened.
5. A status question: names the design and where it is.
6. "thanks": answered as thanks.
7. "can you also make videos?": passed on as a question, never "your change" (L11).
8. A paid night waits for the draft (`in_review`) and checks the round's reported spend against `HAWA_CANARY_MAX_USD` ($0.50). Then "please cancel the … poster, it was only a test" must withdraw it.
9. A second brief, cancelled at once ("…, sorry, it was by mistake"). If the bot asks to be sure, it answers "yes".
10. A brief naming no organisation: "who is this design for?", nothing opened; "it's for <client>" opens it for the canary client; then it is cancelled.
11. Cleanup. Every request of the night, and any left open, ends withdrawn. One that will not close fails the night, by name.
12. Hygiene:
    - no requester-facing message carries a UUID, an internal code (`A_B` capitals) or a chat id;
    - nothing about the canary reached any chat unrecorded.

The result goes to `~/.hawa/logs/canary/<stamp>.json` and `.txt`, and to `latest.*`. Exit codes: 0 passed, 1 failed, 2 could not run.

**`infra/ops/live_canary.sh`**, launch agent `design.hawa.live-canary` at 03:30 (04:30 since ADR-254) (systemd `hawa-live-canary.timer` on Linux):

- It runs on the production host only.
- **The deploy lock.** `infra/ops/deploy_lock.py` is an flock on `~/.hawa/deploy.lock`, released with the process.
  - The canary holds it for its whole run, and skips the night if a deploy holds it.
  - `deploy.sh --apply` now runs under the same lock, after its host-role check and before any change. It waits up to `HAWA_DEPLOY_LOCK_WAIT` (1800 s) for a canary in progress.
  - There was no deploy lock before this.
- **Skips:**
  - the night, when the 1-minute load average is above `HAWA_CANARY_MAX_LOAD` (10);
  - quietly, until `HAWA_CANARY_CHAT_ID` is set in `.env.production`.
- **The backup.** It waits for the nightly backup (also 03:30), which stops Restate and pauses intake for its copy, then waits 2 minutes more. After 45 minutes it skips the night.
- **Time bound.** The run is bounded at 60 minutes. Requests it leaves open are withdrawn first thing the next night.
- **Alerts.** These go through the watchdog's own alert path: `watchdog.sh --notify` reuses its Telegram notify, operator chat and env file. The runner alerts on:
  - a failed night, with the summary;
  - a second skipped night in a row.

## 3. Consequences

- Each of the live test's defect classes now has a nightly check on the real path (the stub night), and the design round has one weekly (the paid night). This covers intake readings, cancels with reasons, the client question, the copy reader, status, the honest question answer, office routing and withdraw.
- What the canary cannot see:
  - delivery: a canary request is never approved;
  - office-member turns;
  - albums, voice and PDFs;
  - Sorani;
  - the model readings: the canary client has no consent.
- The canary's office alerts are recorded, not read, by anyone. The canary checks that they went nowhere.
- A deploy started during a canary run waits for it (at most about an hour on a paid night, usually minutes).
- A canary failure is a real alert at night. The runner sends one message per failed night, not one per check.
- Mixed builds:
  - an older worker has no sink, and the canary stops at its first check;
  - an older Core has no canary allowance, so the first brief would be designed for real every night (bounded by the client's $0.50 limit).
  - **Deploy Core and the worker before installing the agent.**

## 4. Setup for the lead (not done here)

**Superseded in part by ADR-254 (2026-10-02).** Nothing could create a client (no route, no Desk form), so step 1 below could not be done. The canary's client now ships: the client pack `packages/creative/assets/clients/canary-test.json` ("Canary Test", code `canary-test`, id `c1000000-0000-4000-8000-000000000099`) and its row in `db/seed.sql`. Core adds the row at start-up. It is an onboarding pack, so it is never designed for automatically: every night is unpaid, and steps 1 and 2 are only needed to allow paid nights later. Setup is now step 3 (the chat id and the allowlist only) and steps 4–6. The runner now starts at 04:30, not 03:30 (ADR-254).

1. ~~Create the canary client in the Desk.~~ It ships (ADR-254). For a paid night it would need an approved DNA, and its pack would need to go `live`.
2. Before any paid night: set its daily limit to $0.50 in Settings → Spending.
3. `.env.production` (shared; read by Core, the worker's allowlist and the runner):
   - `HAWA_CANARY_CHAT_ID=4503599627370501` (any id in [2^52, 2^53));
   - append it to `TELEGRAM_INTAKE_ALLOWED_USERS`;
   - `HAWA_CANARY_CLIENT_ID` and `HAWA_CANARY_CLIENT_NAME` may stay empty: the script then uses the shipped client, `c1000000-0000-4000-8000-000000000099`, named "Canary Test";
   - `HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK=0`.
4. Deploy (`deploy.sh --apply` regenerates `.env.worker`).
5. Run once by hand: `bash ~/.hawa/current/infra/ops/live_canary.sh`.
6. Install the agent: `bash ~/.hawa/current/infra/ops/install_launch_agents.sh`.

## 5. Verification

- `apps/core/test/live-canary.test.ts` (6). `runCanary` plays the whole night through the worker's ChatInbox, Core's intake on the test database, RequestLifecycle and the worker's own TelegramSender (the conversation harness), configured as production is.
  - **Stub night:** all 43 checks pass. Nothing is sent to Telegram, no office member gets anything, no design round starts, all three requests end `cancelled`, and their tasks carry `canary: true`.
  - **Paid night:** exactly one design round, the first brief's. The change waits for the office instead of a second round. The draft is withdrawn.
  - **No sink configured:** the canary stops after "hi" and opens nothing.
  - **A real chat id as HAWA_CANARY_CHAT_ID:** no sink.
  - The allowance's parsing.
  - A parked canary update alerts nobody.
- `apps/worker/test/canary-sink.test.ts` (11):
  - the reserved range's bounds;
  - the owner's chat configured as the canary is ignored and still gets its message;
  - a sunk message never reaches Telegram and leaves no sent mark;
  - office alerts about a canary task are sunk, and every other message is sent;
  - no canary, no sink;
  - a sunk question is not confirmed;
  - routing;
  - `isCanaryTask` reads a task's intake;
  - the outbox's `notify.telegram`.
- `packages/db/test/worker-role.test.ts` (+1): the restricted worker role (ADR-182) can write the sink's row and make the task check.
- `scripts/test/live-canary.test.ts` (14), over a scripted bot:
  - a sink that is off;
  - a leak;
  - an internal code in a reply;
  - a request that will not close;
  - an earlier night's leftover;
  - a paid night over the cap;
  - configuration, update ids and the night's plan;
  - copy and code detection;
  - reading Restate's journal.
- `packages/testkit/test/live-canary-runner.test.ts` (10), with stubs for uptime, pgrep, sleep and curl:
  - the deploy lock both ways;
  - the load, the backup wait, the host role and an unconfigured host;
  - settings passed to the run;
  - the failed-night alert through the watchdog's path, and the two-skips alert;
  - `deploy.sh`'s lock placement.
- `host-scheduling.test.ts`: changed deliberately for the sixth job.
- **Red before.** The behaviour sources were reverted to `baffce10`; the contracts, the tests and the canary script were kept. Of the 56 tests in the six files, 27 fail. The two integration nights stop at "replies to the canary chat are recorded, never sent" (outcome `sent`). The 29 that pass are:
  - the script's pure judgement tests;
  - the reserved-range bounds;
  - the guards that a real chat is never sunk;
  - the unchanged cases in host-scheduling and worker-role.
- Not run: production, a live Telegram chat, a real Restate server, a paid round, a Linux host's systemd.

**Found while building it** (not fixed here; not this stream's):
- "cancel the … flyer, sorry, it was by mistake" names the design but is asked about ("Do you want me to cancel …?"). ADR-230 §8's reasons cover "by mistake" and "sorry" apart, not "it was by mistake" after "sorry". The canary answers "yes", so it passes, but the bot asked for an answer it did not need.
- On a paid night, "Got it. I'll add that to … as soon as the current draft is done" is told while the allowance will refuse the round. The requester then hears "was finished before your changes could be added", which is true. The first line promised a round that admission had not yet decided.
