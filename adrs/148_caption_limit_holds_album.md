# ADR-148: A Caption Telegram Cut Waits for the Rest

**Date:** 2026-09-30
**Status:** Implemented and locally tested on branch `claude/caption-limit-hold`; not deployed.
**Requirements:** FR-004 (a repeated source event gives no more than one task), FR-005 (passive messages become tasks only through an approved classifier policy), NFR-001 (no acknowledged event is silently lost).
**Changes a foundation:** none. ADR-143's album settle and ADR-145's natural wording are kept. An album whose caption is at Telegram's caption limit is now held, as an album with no words is, instead of being designed from its caption.
**Builds on:** ADR-143 (albums settle by themselves; a waiting album takes its sender's words), ADR-145 (the requester message catalogue; plain words only), commit a2e9f6af (a line that introduces the copy is an instruction).
**Number:** 147 is the highest ADR on every branch, remote and worktree (`git log --all -- adrs/`, 2026-09-30); 148 is free.

## 1. Context

The owner's six-photo album of 2026-09-29 (ADR-143 section 2.5) had a caption of exactly 1,024 characters. That is Telegram's caption limit for standard accounts: Telegram kept the first 1,024 UTF-16 units and dropped the rest without telling anyone. The caption's last line ended mid-sentence ("…and next steps toward"). ADR-143's settle took the caption as the whole brief (`isBriefText`), and the design shipped the cut sentence as its subtitle. (The 1,024 is the production reading reported with this task; the copy of that caption kept in `apps/core/test/brief-introducer-copy.test.ts` measures 1,018 units, so that copy is not byte-exact. This change detects only captions of 1,024 units or more; section 3.)

The requester cannot know that Telegram cut their text. Requesters only write natural messages: no commands, no formats, no reply targets.

## 2. Decision

### 2.1 A caption at the limit is not a whole brief

A caption is **possibly cut** when its length, counted as Telegram counts it (UTF-16 code units, the JavaScript string length), is at or above `TELEGRAM_CAPTION_LIMIT` (1024, `packages/integrations/src/telegram-bridge.ts`, the constant the bridge already uses for outgoing captions). `captionMayBeCut` in `lifecycle-album.ts` is the only test for it.

When an album with such a caption settles (ADR-143, the newest photo's settle), nothing is drafted:

- the album is marked asked (`lifecycle_album_settled`, state `asked`) and the question is recorded once per album (`lifecycle_album_cut`, keyed by the album, with the asking photo's update ID);
- Core answers `settle-later` (kind `album`) with a delay of `CUT_CAPTION_WAIT_MS`, and says one plain sentence beside it (`notice`): "Telegram kept only the first part of the text you sent with the photos. Please send the rest as a message and I'll use it with these photos." (Sorani in a Sorani chat; `ALBUM_MESSAGES.captionCut`, listed in `SORANI_REVIEW.md` for native review.) ChatInbox sends a notice once per update (`chatinbox:notice:<update_id>`), so a replayed or repeated settle does not ask twice.

The worker is unchanged: `settle-later` with a `notice` and a delay of at most 10 minutes is already a valid answer.

### 2.2 The next message is the rest

The album's sender's next text in that chat and topic (ADR-143's `bindTextToAlbum` scope) is joined onto the caption: the request's words are **the caption, a newline, then the message**, and the request opens with all the photos under that message's update ID, as any brief next to an album does. Nothing needs to be a brief by the classifier's rule: the rest of a sentence is rarely one. Only these are not taken as the rest:

- an OK ("ok", "yes", "go ahead"): the requester is asked for the rest again (`album-rest:<update_id>`), and the album keeps waiting;
- thanks or a receipt (`isAcknowledgement`), and `/`-commands: left to intake as before.

When the message repeats what Telegram kept, the repeat replaces it instead of doubling it: the whole brief sent again is the brief, and a message that starts with the cut last line (the sentence sent again whole) replaces that line.

### 2.3 The wait is bounded; nothing is lost

The album waits for `CUT_CAPTION_WAIT_MS`, which is the held-brief window (`HELD_BRIEF_MS`, 10 minutes: "a held brief is never held longer"). The timer is ADR-143's own mechanism: the durable Restate delayed call of the album's settle, which Core asks for in its `settle-later` answer. The poller's settle sweep (ADR-143, every five minutes) also lists a cut album whose question is more than 11 minutes old and less than the album brief window (2 hours) old and which has not opened, in case the delayed call was lost.

When the settle comes after the window and no rest has arrived, the album opens **with the caption's complete lines only**: the cut last line is dropped (`withoutCutLine`). A caption of a single line keeps its complete sentences. The requester's words are therefore not lost, and the cut line never becomes copy. A caption with no complete line or sentence left (one unbroken run of 1,024 characters) opens nothing; the requester was asked, and the album lapses with its window like an album with no words.

The settle's other ADR-143 rules still apply: a late settle starts nothing once the chat has opened another request after the photos, and one album opens at most one request (the freeze is under the album lock; the outcome is stored under the source update).

### 2.4 A title is not a headline

The task list (`GET /v1/tasks`) showed a task's title as its English headline when the task had none (`headline_en || title`). A lifecycle draft carries no `headlineEn`, so every Telegram task showed its title there, and a task made before a2e9f6af showed "KAAE: Here is the text and the photos:…" as its headline. The fallback now drops a title that quotes a line introducing the copy (`isCopyIntroducer`, from a2e9f6af); other titles are shown as before.

## 3. Consequences

- An album whose caption was cut starts about as soon as the requester sends the rest, or 10 to 15 minutes after the photos if they send nothing. A rest sent after the album opened is read by intake as any later message from the requester (ADR-144 routing).
- A Telegram Premium account can send captions up to 4,096 units. Its complete caption of 1,024 units or more is also held and asked about; the requester's reply is joined, or after the window the caption opens without its last line. The office's accounts are standard; this is accepted.
- If Telegram strips whitespace after cutting, a cut caption can arrive one unit short of the limit and is not detected. The owner's caption arrived at exactly 1,024.
- The rest of a sentence that was cut mid-word ("…next steps tow" then "ard a better future") is joined after a newline, as specified, so the design reads it as the next line. A requester who sends the whole last sentence again gets it as one line (section 2.2).
- A single captioned photo (not an album) whose caption is at the limit is not covered by this change: ADR-145's photo path still opens it with its caption. It is recorded as open work.
- Every text message from a sender now runs ADR-143's album lookup unless it is thanks, an OK or a command (previously only briefs and OKs did): two indexed reads and a transaction-scoped advisory lock, no write unless an album is bound.
- No migration. New `inbox_events` account: `lifecycle_album_cut`. Core only; the worker and the Restate services are unchanged. The Sorani sentence is the implementer's and awaits native review.

## 4. Verification

- `apps/core/test/lifecycle-album-caption-limit.test.ts` (9 tests, per-file PostgreSQL, the worker intake route):
  - six photo updates, the first with a 1,024-character caption ending mid-word (built from parts): no task, no open, and exactly one requester sentence, the plain question, beside a 10-minute settle; a repeated settle is still waiting;
  - the next plain message: the draft's `rawText` is the caption, a newline and the message; the headline is the title line, not the introducer; a replay gives the recorded decision; the album's own settle then does nothing; one task after projection;
  - a 1,023-character caption drafts at the settle, as before;
  - an OK is asked again; after the window the sweep lists the album and its settle opens it without the cut line (no copy block or draft field contains it); the replay is a duplicate and the sweep lists it no more;
  - the whole brief sent again replaces the cut caption;
  - helpers: the UTF-16 count (an emoji is two units), dropping the cut line or sentence, the join and its repeat rules, and the title fallback.
- Neighbouring suites re-run unchanged: `lifecycle-album-settle`, `lifecycle-album`, `brief-introducer-copy`, `natural-media-intake`, `natural-language-friction-audit`, `lifecycle-internal-intake`, `lifecycle-source`, `lifecycle-voice`, `route-inventory`, `core`, `no-invented-copy-routes` (Core); `chat-inbox`, `telegram-poller` (worker); `requester-messages`, `telegram-message-length` (integrations).
- Not run: chaos scenarios, live Telegram, a real Premium account, and a native Sorani review.
