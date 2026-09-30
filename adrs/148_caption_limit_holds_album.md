# ADR-148: A Caption Telegram Cut Waits for the Rest

**Date:** 2026-09-30 (reworked the same day after the adversarial review, audit 2026-09-30 item 22)
**Status:** Implemented and locally tested on branch `claude/caption-limit-hold-v2` (rebased onto production `6bd479c1`); not deployed. Supersedes the first version on `claude/caption-limit-hold`, which was not merged.
**Requirements:** FR-004 (a repeated source event gives no more than one task), FR-005 (passive messages become tasks only through an approved classifier policy), NFR-001 (no acknowledged event is silently lost).
**Changes a foundation:** the lifecycle album contract (`parseLifecycleAlbumRef`, `packages/contracts`) now allows up to 20 photos instead of 10 (section 2.8). ADR-143's album settle, ADR-144's group rule and ADR-145's natural wording are kept.
**Builds on:** ADR-143 (albums settle by themselves; a waiting album takes its sender's words), ADR-144 (requester intent rules; section 2.7, groups), ADR-145 (the requester message catalogue; plain words only), commit a2e9f6af (a line that introduces the copy is an instruction).
**Number:** 148 is reserved for this stream.

## 1. Context

The owner's six-photo album of 2026-09-29 (ADR-143 section 2.5) had a caption of exactly 1,024 characters. That is Telegram's caption limit for standard accounts: Telegram kept the first 1,024 UTF-16 units and dropped the rest without telling anyone. The caption's last line ended mid-sentence ("…and next steps toward"). ADR-143's settle took the caption as the whole brief, and the design shipped the cut sentence as its subtitle.

The first version of this ADR held such an album and joined the sender's next message onto the caption. Its adversarial review found that it joined "cancel", "hello" and questions as "the rest" (each a paid design), glued an unrelated brief sent 31 minutes later onto the old caption (the album accepted words for its 2-hour window), held complete Premium captions longer than 1,024 as cut, could open a design whose whole brief was a one-word label, let another group member's request silently drop the album, joined a word cut in two with a line break ("tow" / "ard"), doubled a resent tail, and never left the `asked` state (the sweep revisited it). This version fixes those; the review's seven probes are regression tests.

The requester cannot know that Telegram cut their text. Requesters only write natural messages: no commands, no formats, no reply targets.

## 2. Decision

### 2.1 Which captions were cut

A caption is **possibly cut** (`captionMayBeCut`) when its length, counted as Telegram counts it (UTF-16 code units, the JavaScript string length), is:

- exactly `TELEGRAM_CAPTION_LIMIT` (1,024); or
- at most 4 units short of it and ending mid-sentence (Telegram can drop trailing spaces or line breaks after its cut); or
- exactly 4,096, Telegram Premium's caption limit.

Any other caption longer than 1,024 came whole from a Premium account and is drafted as any caption is.

### 2.2 The question

When an album with a possibly cut caption settles (ADR-143, the newest photo's settle), nothing is drafted. The question is recorded once per album (`lifecycle_album_cut`, keyed by the album's first group, with the asking update), the album is marked `asked`, and Core answers `settle-later` (kind `album`) with a delay of `CUT_CAPTION_WAIT_MS` and one sentence beside it (`notice`), quoting the last words that arrived (`captionTail`, at most five words):

> I have your photos, but Telegram cut your text short: it stops at "…next steps tow". Please send me the rest, or the whole text again, and I'll use it with these photos.

(`ALBUM_MESSAGES.captionCut`; Sorani in a Sorani chat, with «…» quotes.) ChatInbox sends a notice once per update, so a replayed or repeated settle does not ask twice. If an "ok" arrives before the settle, the question is asked then and recorded under that message instead.

### 2.3 What counts as the rest

While the album waits, its sender's words (ADR-143's `bindTextToAlbum` scope: same chat, sender and topic) are read by `readCutReply`, which uses the requester-turn rules of ADR-144 (`readIntentByRules`, and the classifier's greeting and question reading) rather than word lists of its own:

| The words | What happens |
|---|---|
| a cancel ("cancel", "never mind, wrong photos": a cancel said first, then why) | the album is closed (`cancelled`) and the requester is told: "OK, I won't make anything with these photos. Send them again whenever you're ready." |
| an OK or approval words ("ok", "yes", "go ahead") | asked again, in fewer and different words (`captionCutAgain`): "I still need the rest of your text after "…next steps tow". Please send it as a message, or send the whole text again." |
| thanks, a greeting, a question, a status question, a lasting preference | left to intake, answered as usual; the album keeps waiting |
| "that's the whole text", "nothing else" (English and a few Sorani phrases) | the caption opens as it arrived |
| anything else | the rest |

Words that a voice note or a PDF waits on (ADR-145's "Is this exactly the text?") are that source's, not the rest.

A **photo with words** sent while the album waits is read the same way; as the rest, its words join the caption and its picture joins the album (one request, the album's photos then this one).

### 2.4 The join

The rest joins the caption where Telegram cut it (`joinCutCaption`):

- the whole text sent again (it starts with the caption's first 80 characters) replaces the caption;
- a rest that repeats the end of what arrived overlaps it once: the longest overlap of at least three characters that starts at a word of the caption, compared with spaces and line breaks folded and case ignored ("…steps tow" then "steps toward better…" gives "…steps toward better…");
- otherwise a cut mid-word joins with nothing between ("tow" + "ard"): the caption ends with a letter and the rest starts with a lower-case or uncased letter (Sorani has no case), or both are digits; a cut mid-sentence joins with a space; a caption that ended a sentence joins with a line break.

### 2.5 The wait

The album takes the rest only until `CUT_CAPTION_WAIT_MS` (10 minutes) after the question (or after its newest photo, before the question), not for the album's 2-hour window. The wait is one durable settle: `CUT_CAPTION_WAIT_MS` equals the worker's longest settle delay (`MAX_SETTLE_DELAY_MS` in `apps/worker/src/lifecycle/core-client.ts`, which refuses a longer one), and a test fails if either changes alone. The poller's sweep (ADR-143) also lists a cut album whose question is more than 11 minutes old and which is neither frozen nor closed, in case the delayed call was lost.

At the end of the wait, with no rest:

- the caption without its unfinished sentence (`withoutCutSentence`: only the last line is trimmed, back to its last finished sentence, or away when it has none) opens, if it is still a brief: `isBriefText` and a `new_brief` by the requester-turn rules, so a lone label such as "KAAE" is not;
- otherwise the album **lapses**: it is closed (`expired`) and the requester is told "I didn't receive the rest of your text, so I haven't started a design with these photos. Whenever you're ready, send the photos again and then the whole text as a message."

Words sent after the wait are read by intake as any message; they never join the old caption.

### 2.6 Final states are recorded

`inbox_events` is append-only, so ADR-143's `lifecycle_album_settled` row, once `asked`, could never change. A final state reached later (`superseded`, `expired`, `cancelled`, `refused`) is its own row, `lifecycle_album_closed`, which `settledState` reads first. A closed album is not settled, bound or swept again.

### 2.7 Groups (ADR-144 section 2.7)

- A late settle is superseded only by a later request **of the album's sender** (found through the open decision's source update or its intent receipt). Another member's request says nothing about this member's photos. In a private chat any later request supersedes, as before.
- Media follows the rule text follows: in a group, only what is addressed to the bot (a reply to it, a mention of it in the text or caption, a command) or is a clear brief (said to be new, a divider, a copy heading) acts (`actsInGroup`).
  - A photo with words, a file, a voice note, a video or a sticker that does not act is kept as a passive message (`MESSAGE_ONLY`) before anything is downloaded, and nothing is said.
  - An album that does not act is marked `asked` quietly at its settle: no question, no design; its sender's own words that act can still bind it. A refused photo in a group album is said at the settle, only if the album acts.
  - A photo with no words is kept, as ADR-145 keeps it, but its settle asks nothing in a group; its sender's words within the join window can take it.
  - Words that do not act never bind an album.

### 2.8 Albums sent back to back

Telegram sends at most ten photos per album and splits more into albums delivered one right after the other. Albums from one sender (chat and topic) whose photos follow each other within the album quiet period (`HAWA_ALBUM_SETTLE_MS`), and that are not started or closed, are one **set** (`albumSet`): the newest photo of the set settles it, it is asked about once ("I have your 13 photos …"), a brief binds every photo of the set, and every group of the set is frozen or closed together. The album contract allows up to 20 photos (`MAX_ALBUM_IMAGES`); a set with more is refused as too large ("These photos are too large together. Please send fewer or smaller photos.").

### 2.9 A stranger's video (audit S5)

A video from a sender outside the intake list is refused before `mediaRoute.unusable` records anything of it; the sender hears ADR-145's once-a-day line, and only its rate-limit row is kept.

### 2.10 A title is not a headline

The task list (`GET /v1/tasks`) showed a task's title as its English headline when the task had none. The fallback now shows nothing when the title quotes a line introducing the copy, with a client prefix ("KAAE: Here is the text and the photos:…") or without one ("Here is the text and the photos:…").

## 3. Consequences

- An album whose caption was cut starts as soon as the requester sends the rest, or about 10 minutes after the question if they send nothing and what arrived is still a brief; otherwise the requester is told it lapsed.
- A requester who answers the question with a greeting or a question gets the usual answer, and the album keeps waiting; a cancel is honoured. Each of these was a paid design before.
- A cut that falls exactly at the end of a word, followed by a rest that starts with a new lower-case word, is joined without a space ("steps" + "toward" gives "stepstoward"): the join cannot tell this from a word cut in two. The question quotes the last words, so a requester who sends the rest from the start of that word is joined correctly by the overlap rule.
- A caption of 1,020 to 1,023 units that ends mid-sentence but was not cut is asked about; the requester's "that's the whole text" opens it.
- The album contract now allows 20 photos. Every model call that receives a request's photos can receive up to twice as many images (more input tokens per call, no additional calls). Core and the worker must run the same `@hawa/contracts` build: an older worker refuses a draft with more than 10 photos.
- In a group, media that is not addressed to the bot is now passive: photos and files from members no longer start designs or questions (audit item 14). A captionless photo in a group is still kept for its sender's words.
- A single captioned photo (not an album) whose caption is at the limit is not covered: ADR-145's photo path still opens it with its caption.
- A voice note sent as the rest is not joined: the source flow (ADR-145, `lifecycle-source-intake.ts`, owned by the intake stream) opens its confirmed words as their own request, and the album then lapses or is superseded. Joining it needs that flow to bind a waiting cut album on confirmation; the album contract cannot carry a source reference and an album together today.
- Every text message from a sender runs ADR-143's album lookup (two indexed reads and a transaction-scoped advisory lock, no write unless an album is bound); in a group, a message is read by the requester-turn rules once more.
- No migration. New `inbox_events` accounts: `lifecycle_album_cut`, `lifecycle_album_closed`. Core, `@hawa/contracts` and one worker constant change. The Sorani sentences and the Sorani "that is the whole text" phrases are the implementer's and await native review (`SORANI_REVIEW.md`).

## 4. Verification

- `apps/core/test/lifecycle-album-caption-limit.test.ts` (24 tests, per-file PostgreSQL, the worker intake route). Run against the first version's code, 23 of the 24 fail; with this change all pass:
  - the six-photo album: no task, one question that quotes the last words; the rest joins a word cut in two; the rest before the settle; a resent tail and the whole text sent again are not doubled; an OK is asked again in fewer words; the sweep and the settle open without the unfinished sentence;
  - F1: "cancel" and "never mind, …" close the album and say so; "hello", "what do you mean?", "thanks" and "when will it be ready?" are never joined; "that's the whole text" opens the caption; `readCutReply` cases;
  - F2/F5: a rest after the wait is not joined; a caption with no finished sentence lapses, says so, is not swept again, and a brief 30 minutes later opens alone; "KAAE" plus an unfinished paragraph lapses;
  - F4: 1,500 and 1,019 units and a finished 1,023 draft at once; 1,022 mid-sentence and 4,096 are held; the UTF-16 count;
  - F6: another member's request does not supersede; the sender's own request does, and the album is not swept again; un-addressed group albums, photos with words, voice notes and captionless photos start nothing and say nothing, and addressed words bind the album;
  - F8: a photo with words as the rest gives one request with seven photos; F8-albums: 10 + 3 photos are asked about once and bind all 13;
  - S5: a stranger's video leaves only the rate-limit row; Sorani question; F10 title; F11 wait against `MAX_SETTLE_DELAY_MS`; the trim and join helpers.
- `apps/core/test/lifecycle-album.test.ts`: the contract bound (20 accepted, 21 refused).
- Neighbouring suites re-run: see the traceability rows and the branch report.
- Not run: chaos scenarios, live Telegram, a real Premium account, a real two-album upload, and a native Sorani review.

## 5. Addendum (integration, 2026-09-30): a voice note or a PDF sent as the rest

Section 3 left this open: the source flow opened a voice note's confirmed words as their own request. On the integration branch (`claude/integrate-audit-fixes`), once a voice note's or a PDF's words are confirmed ("yes", or the corrected text), `confirm` in `lifecycle-source-intake.ts` first calls `bindSourceToCutAlbum` (`lifecycle-album.ts`). If the sender's cut album waited when the source arrived (after the photos, within `CUT_CAPTION_WAIT_MS` of the question), the confirmed words join the caption by the section 2.4 rules under the confirming message's update, and intake reads that album as it reads one bound by typed words. The result is one request with the photos and the whole text.

- **The contract is unchanged.** It still refuses a draft with a source reference and an album. The bound draft carries only the album: the confirmed words travel as the album's words, as typed words do. The voice note or PDF stays kept, confirmed and held for manual review for the office, but the task does not carry `reviewedSource`.
- **The wait.** While such a source waits for its confirmation, the settle keeps the album waiting (quietly, one settle at a time) up to `SOURCE_REST_WAIT_MS` (30 minutes) after the question, and the sweep skips it until then. After that, the album opens or lapses as section 2.5 says. A source still waiting for "which organisation?" has no words to show yet, so it does not extend the wait.
- **Replays.** An update that bound an album replays through its recorded album decision (now read before the command check, so a `/use_source` confirmation replays too). Intake no longer reads an admitted album's words as a source's answer.

Test: `apps/core/test/intake-cross-stream-adr148-156.test.ts` (F8 remainder: one request, the draft without `lifecycleSource`, a replay, the settle skipped; the 11-minute wait kept and not swept). Before the change, the first test opened a second request with only the heard words, and the second test opened the album at its settle.
