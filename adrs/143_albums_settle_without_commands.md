# ADR-143: An Album Starts by Itself; a Brief Next to Photos Is One Request

**Date:** 2026-09-29
**Status:** Implemented and locally qualified; not deployed.
**Requirements:** FR-004 (a repeated source event gives no more than one task), FR-005 (passive messages become tasks only through an approved classifier policy), FR-060 (resume after a restart without repeating side effects), NFR-001.
**Changes a foundation:** ADR-068 ("A quiet timer cannot establish that all files arrived … the sender replies to any part with `/use_album`"; "a confirmation cannot select a neighbouring album by recency"). A quiet period now settles an album, and the requester's own words bind their newest waiting album.
**Builds on:** ADR-068 and ADR-069 (album collection, the frozen manifest), ADR-135 (every chat is lifecycle-owned; the open starts the design), ADR-139 (one request per language), ADR-140 (thanks are not briefs).

## 1. Context

The owner's first real test (2026-09-29, 12:09:38Z): an album of six photos whose caption was the full brief of a KAAE report cover. The bot answered "Album photos are being saved. After every photo has finished sending, reply to any photo in this album with /use_album. No design has started yet." At 12:44:37Z the owner sent `/use_album` as a plain message, not as a reply to a photo, and was told to reply to a photo. No request started. The owner: requesters write natural messages and must never need a command.

ADR-068 asked for the command for two reasons. Telegram delivers an album as one update per photo with no expected total, so intake cannot know when the last photo has arrived. An accidental album must not start a paid design.

## 2. Decision

### 2.1 The album settles

- A saved photo is answered `settle-later` and the requester is told nothing. ChatInbox schedules a **durable Restate delayed call** of its new exclusive handler `settle`, under the idempotency key `settle:<update_id>` of that photo. The call is stored by Restate, so a worker or Restate restart during the quiet period loses nothing, and it runs in the chat's queue, after the chat's earlier updates.
- Only the settle scheduled by the album's **newest** photo acts. An older photo's settle finds a newer photo in the group and does nothing. So the album settles once no photo has arrived for the quiet period.
- The quiet period is **8 s** (`HAWA_ALBUM_SETTLE_MS`, 2–120 s). A Telegram client sends an album as one request, and the Bot API hands its photos over one after another; they reach the poller in the same or the next `getUpdates` answer. The timer starts after ChatInbox has saved each photo (download included), so a slow download does not shorten it. Eight seconds is several times that spread, and the acknowledgement still reaches the requester about ten seconds after the album.
- Core settles under the sender's and the album's advisory locks and stores the outcome under the newest photo's update ID (`lifecycle_album_confirm`, the same record a confirmation writes). The album is frozen once (`lifecycle_album_frozen`). A retried, repeated or restarted settle answers with the stored outcome; the rest of intake replays the recorded open decision. One album therefore opens at most one request (one per language under ADR-139).
- **A caption that is a brief** (the intake's own rule: `classifyWithHeuristics` says `new_brief`) starts the request with every photo, with no question and no confirmation.
- **Photos sent in reply to a request's notice** are that request's reference, as a replied single photo already was: the settle starts the revision.
- **An album with no words** (or a caption that is only an OK, thanks or chatter) is asked about once:
  - English: "I have your 2 photos. What would you like me to design with them? Please tell me what it is for and the exact words to put on it."
  - Sorani: "٢ وێنەکەتم پێگەیشت. دەتەوێت چ دیزاینێکیان پێ دروست بکەم؟ تکایە بۆم بنووسە بۆ چییە و ئەو دەقانەی دەبێت لەسەری بنووسرێن."

  The reply language follows the lifecycle's rule (Sorani when the requester writes Sorani): the album's own words, else the chat's newest brief, else the sender's Telegram language (`ckb`/`ku`). No paid design starts without a brief, which keeps ADR-068's accidental-album safety.
- Different captions on one album are asked about ("Your photos came with different captions, so I am not sure which one is the brief. Please send the brief again as one message."). A photo that could not be saved, a one-photo group and photos replying to different messages are answered and start nothing, as before.

### 2.2 The requester's words bind a waiting album

A text from the album's sender in the same chat and topic binds the sender's newest album that is not frozen, has no refused photo, and is in its window (two hours for an album with no words, `HAWA_ALBUM_BRIEF_WINDOW_MINUTES`; 72 hours for a captioned one, `HAWA_ALBUM_RESUME_HOURS`). This holds whether the text comes before the album settles or after the question.

- **A brief** freezes the album under the text's own update ID and opens one request with those photos. A captioned album and a brief sent next to it are one brief, the caption first.
- **An OK without a brief** ("yes", "use them", "go ahead", "بەڵێ", a plain `/use_album`) starts a captioned album; for an album with no words it is asked again ("Happy to. What should I design with these photos? Tell me what it is for and the exact words to put on it." / "بە دڵخۆشییەوە. چ دیزاینێک بەم وێنانە دروست بکەم؟ پێم بڵێ بۆ چییە و ئەو دەقانەی دەبێت لەسەری بنووسرێن.").
- **Anything else** (thanks, a greeting, a question) is left to intake as before, and the album keeps waiting.
- A reply to a request's own notice stays about that request. An update intake has already decided (an open, a refusal, a revision receipt) keeps that decision even if an album arrived since.
- `/use_album` replying to a photo keeps its ADR-068 meaning. A plain `/use_album` is an OK as above. With no album waiting it is answered "I could not find photos from you waiting in this chat. Please send the photos again with what you would like designed." No message to a requester names a command.

### 2.3 A text brief waits briefly for photos sent after it

A text brief from a worker that says it schedules settles (`briefHold: true` in the intake call) is held for **15 s** (`HAWA_BRIEF_PHOTO_WAIT_MS`, 0 turns it off) instead of opening at once. On 2026-09-22 a brief was followed by two images 10 and 12 seconds later. The held brief's settle opens it as intake opens any brief. If an album from the same sender began after the brief and is still arriving, the brief's settle waits for the album (`settle:<id>:<n>`, at most 60 rounds). A captionless album that settles takes the held brief as its brief (`lifecycle_brief_consumed`), and the brief's own settle then does nothing. A captioned album is complete on its own and does not take a held brief. Without `briefHold` (an older worker, or Core called directly) a brief opens at once, as before.

### 2.4 A photo after the design started

A photo that arrives after its album was frozen is **not** added. The task's source event carries the frozen album manifest, and the planner and Studio refuse task files that differ from it (`orderedAlbumImages`). Since ADR-135 the open also starts the design run, so there is no "before planning" moment to add it in. The requester is told "This photo arrived after I had started your design, so it is not part of it. When the draft is ready, reply to it with this photo and tell me what to change." (Sorani: "ئەم وێنەیە دوای دەستپێکردنی دیزاینەکەت گەیشت، بۆیە بەشێک نییە لێی. کاتێک ڕەشنووسەکە ئامادە بوو، بەم وێنەیەوە وەڵامی بدەرەوە و بڵێ چی بگۆڕدرێت."). A reply to the draft with that photo is a revision reference under the existing rules. A photo that arrives after the question but before any brief joins the album.

### 2.5 Overdue settles: the sweep, and the owner's album

The worker's poller asks Core (`POST /v1/internal/telegram/settle-sweep`) at start and every five minutes for overdue settles. These are albums whose newest photo is more than 68 seconds and less than 72 hours old, not frozen and not settled, and held briefs over 75 seconds old that were neither opened nor taken. It sends each one to its ChatInbox `settle` under `settle-sweep:<update_id>`. The sweep covers albums saved before this change, which never had a timer, and delayed calls lost by an operator. The settle decides under the same locks, so a sweep can start nothing twice. A late settle (more than five minutes after the newest photo) starts nothing if the chat opened another request after the album. An old album with no words past its two-hour window lapses silently instead of asking a stale question.

The owner's album of 2026-09-29 12:09:38Z has a caption brief, six saved photos, no frozen marker and no settle outcome. On the first poll after the deploy the sweep settles it, and it opens one request with all six photos. The plain `/use_album` refused at 12:44:37Z keeps its stored refusal. Its replay answers as before and starts nothing. If the owner has since sent the brief again and a request opened in that chat, the album starts nothing (superseded) and is not designed twice.

## 3. Consequences

- A requester sends photos with their brief, in one message or two, and the design starts. No command is mentioned anywhere.
- A text-only brief starts its design about 15 s later than before (its acknowledgement too). The design itself takes minutes. Intake decides a held brief when it settles, so a request that began waiting for this requester in those 15 s takes the brief as its revision, as it would take any unlinked message (ADR-135).
- A single captionless photo with no reply is still held for an operator, as before. Only albums (two to ten photos) settle.
- The quiet period cannot prove that every photo arrived, and neither could the confirmation. A photo arriving more than 8 s after the previous one, once the design has started, is explained to the requester and not lost silently.
- Every text message now runs two indexed reads of the sender's albums and held briefs before intake. Nothing is written unless a waiting album is bound.
- Sorani wording is the implementer's. The owner should read it before live admission.
- No migration. New `inbox_events` accounts: `lifecycle_album_settled`, `lifecycle_brief_held`, `lifecycle_brief_consumed`, `lifecycle_brief_released`. New ChatInbox handler `settle` (a new worker deployment registers it; no service is added or removed). Core and worker deploy together. Alone, a new Core with the old worker saves photos silently and the album waits for the new worker's sweep. A new worker with the old Core gets the old `/use_album` notice. A rollback to the previous release leaves any settle due within its quiet period (8 s after an album, 15 s after a brief) without a `settle` handler. The next forward deploy's sweep settles those albums and briefs (72 h and 24 h windows).

## 4. Verification

- `apps/core/test/lifecycle-album-settle.test.ts` (14 tests, per-file PostgreSQL, the worker intake route). One settle of the newest photo opens one request, including under two concurrent settles and a restarted Core. A Core killed after freezing and before deciding resumes into one decision. A late photo is kept out and explained. The no-words question: "yes" is asked again, thanks is left to intake, and a brief then opens with the photos. The question is in Sorani for a Sorani chat. Photos then a text brief open one request, and a text brief then photos open one request. A held brief with no photos opens once. `/use_album` works as a plain message and is never mentioned. An album stored before this change (with its refused plain `/use_album`) is started by the sweep exactly once. An overdue album is superseded once the chat moved on, and one with no words lapses. A settle, two plain `/use_album`s and a second settle racing freeze once. A revision album starts its revision at the settle. The classifier boundary for OKs and briefs is also covered.
- `apps/core/test/lifecycle-album.test.ts`: the ADR-068 tests, updated to the silent part answer and the new late-photo text.
- `apps/worker/test/chat-inbox.test.ts` covers: the settle schedule under a stable key across a crash, the settle's open without moving `lastUpdateId`, the bounded re-settle, a failing settle that is never parked, and the Core client's `settle`/`briefHold` fields and answer validation. `apps/worker/test/telegram-poller.test.ts`: the sweep's keys, interval, failure tolerance and kill switch.
- Chaos (worker mode, fakes for Telegram, Canva and models; results in section 5).

## 5. Local qualification — 2026-09-29

- Unit and PostgreSQL: `lifecycle-album-settle.test.ts` 14/14 and `lifecycle-album.test.ts` 12/12. The lifecycle, Telegram and worker subsets passed: 65 files, 662 passed, 4 skipped, before the replay fix below. `pnpm typecheck` (594 test roots) and `pnpm lint` passed.
- Chaos, worker mode, fakes for Telegram, Canva and the models (`npx tsx packages/testkit/chaos/run.ts --poller worker`):
  - Album run: R1.S3.ALBUM_BRIEF, R1.S3.ALBUM_RESTART, R1.S3.ALBUM_ASK, R1.S3.ALBUM, R1.S3.DOCUMENT_ALBUM, R1.0 and R1.S3.K1 passed **7/7, 100/100 invariants**. ALBUM_BRIEF: an album of three photos whose caption is the brief, Core SIGKILLed at `core.intake.after-album-settle`, one request, one plan call, approved and delivered, all three photos as the task's reference images, one download per photo, a second settle of the newest photo started nothing, and no message named a command. Results: `plans/lean-design-implementation-2026-09-28/ADR143_ALBUM_CHAOS_RUN.json`.
  - Full suite: **44/47** (669/670 invariants). The three failures were the chaos checks, not the product:
    - R4 required chat B's acknowledgement within 5 s. With the 15 s brief hold it came after 15.4 s, while chat A's download took 30.5 s.
    - R1.DUP expected a replayed brief (under a second Restate key) to be answered 200. It was answered "settle later" again. Now a replay of a released held brief replays its recorded open, and a brief an album took answers `duplicate`; both have unit tests.
    - ALBUM_RESTART killed only worker-blue, while an earlier scenario had left worker-green serving, so the settle ran there. The scenario now kills and restarts every running worker.

    Results: `ADR143_FULL_CHAOS_RUN.json`.
  - Rerun after those fixes: R1.DUP, R4 (chat B after 16.1 s, chat A after 31.1 s), R1.S3.ALBUM_RESTART, R1.S3.K1, R1.S3.ALBUM_BRIEF and R1.S3.ALBUM_ASK passed **6/6, 80/80**. Results: `ADR143_CHAOS_RERUN.json`.
  - R10 (`--only R10.H1,R10.K1,R10.K2 --previous-release 5038a648`): the first run failed two scenarios.
    - R10.H1 checked chat B's aged brief 3 s after its update, before the brief's 15 s settle had opened it. The step now waits for the settle.
    - R10.K1 failed in its rollback with "fetch failed; other side closed". The driver's first request to the fakes after a blocking `docker compose` had gone out on a keep-alive socket the fakes had closed as idle; such a request (UND_ERR_SOCKET) never reached the server and is now sent once more.

    Rerun: **3/3, 151/151** (H1 80, K1 54, K2 17). Results: `ADR143_R10_RUN.json`.
- Full suite (`HAWA_TEST_WORKERS=3 pnpm test`, Desk built): 593 files; 5020 passed, 67 skipped, 3 failed:
  - `route-inventory.test.ts`: the new `settle-sweep` route was missing from the fixture. It was added and the test now passes, 23/23.
  - `validate-pack-tool-caches.test.ts`: the refreshed manifest named this ADR before it was committed. It passes once the ADR is committed.
  - `r11-release-gate.test.ts` test 1: expected, because `RELEASE_MANIFEST.json` is not re-sealed on this branch.
- Not run: live Telegram, the real models or Canva, and a real Sorani reader's check of the wording.
