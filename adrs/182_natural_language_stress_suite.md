# ADR-182: Natural-Language Stress Suite and Requester Friction Repairs

**Date:** 2026-09-30
**Status:** Implemented and locally tested on branch `claude/nl-stress` (from production `36369a12`); not deployed.
**Requirements:** FR-005 (passive messages become tasks only through an explicit command, mention, Desk action or an approved classifier policy), FR-004 (a repeated source event gives no more than one task), NFR-001 (no acknowledged event is silently lost).
**Changes a foundation:** no. No table, migration, dependency, model call or new inbox-ledger kind.
**Builds on:** ADR-143 (held briefs), ADR-144 (requester intent routing), ADR-145 (natural media and wording), ADR-156 (intake friction repairs), ADR-155 (office alerts to every member), ADR-040 addendum (office approval in Telegram).
**Number:** 182, reserved for this stream by the lead.

## 1. Context

Owner rule (2026-09-29): requesters use natural language only, and friction is hunted always. The earlier friction audits (NATURAL_LANGUAGE_FRICTION_AUDIT, ADR-156) read single messages. Real requesters hold conversations: a brief typed as three messages, a forward and then "make a poster from this", a correction a minute later, "??" after half an hour, a question the bot cannot answer, a reply to the delivered file. This stream plays whole conversations through the production code and holds each to what a thoughtful office assistant would do.

## 2. Decision

### 2.1 A conversation harness that runs in CI

`apps/core/test/fixtures/conversation-harness.ts` plays a conversation through the worker's own code and Core's real intake route, against the per-file test database:

- every update goes through ChatInbox (`handleUpdate`, and `settleUpdate` for each settle Core asks for), whose Core client (`createCoreClient`) calls Core's `/v1/internal/telegram/intake` with the worker credential;
- what ChatInbox sends goes through TelegramSender (`handleSend`), which writes the real send marks, so a reply to a bot message binds exactly as in production; the fake Telegram only numbers messages (one message-id sequence per chat, shared by people and bot, as Telegram does);
- a request is opened by RequestLifecycle's `openAutomaticRequest` / `openManualRequest`, a requester's change started by `recordRequesterDecision`, a draft finished by `recordDesignFinished` (a Canva binding, its exports and a passing check stand in for the design run, which is never started), and an office member decides in their private chat through `officeTelegramTurn`, the signed OfficeDecisionGateway (checked as the worker checks it), `recordOfficeRevision` and `recordOfficeDeliveryStart`. Delivery's end is written to Core's rows, with the notice sent under the Delivery workflow's own key (`dl-<task>-<approval>:notice`);
- time is virtual: a step says how long after the previous one it was sent; moving the clock moves every row back (Postgres decides every settle and window from `now()`), and the settles that fall due run in order, as Restate's delayed calls would;
- no model is called: the intent router is off (rules only), a voice note's transcription and a PDF's reading are the script's words behind a fake provider and a fake Docling, and any other provider call fails the script.

`fixtures/conversation-script.ts` is the script language (`Play`: say, forward, photo, album, voice, pdf, sticker, edit; the office's draft, reply and delivery) and the rules every conversation keeps (`frictionIssues`: no command, id, internal word, "Directive (…)", demand to reply to a particular message or to use a format, or the office tool's name; an answer to every message a person sends in a private chat). `natural-language-stress.test.ts` runs 121 scripts (`fixtures/nl-scripts/`: briefs, changes, conversation, media, office and groups) in English, Sorani, Kurmanji and Sorani in Latin letters, Arabic-Indic digits and mixed. `HAWA_NL_TRANSCRIPTS=<dir>` writes each conversation as it was said. A script marked `open` is a known defect: it asserts the natural outcome and runs as `it.fails` until fixed.

### 2.2 Repairs

| # | Found | Repair |
|---|---|---|
| 1 | A brief typed as several messages ("Hi, we need a poster for the graduation" / "Date: 12 October at 5 pm" / "Venue: the main hall") opened with its first line only, and the rest were each asked "change or new? Just say change or new"; in Sorani the details opened a second paid request. "and use our blue colours" five seconds after a brief was a note the draft never saw. A forward then "please make a poster from this" opened two requests; "can you make a poster from the message below?" then the forward opened a designer's request and asked about the forward. | While ADR-143 holds a brief, a message of the same sender within the brief's own hold (`HAWA_BRIEF_PHOTO_WAIT_MS`, 15 s) of the part before it joins it when it reads as more of the brief (`readsAsBriefContinuation`: a detail, a date line, a line of style or timing, "make a poster from this"; not thanks, a question, a status, a cancel, a correction of what was just said, or another design with its own copy), and a forward right after its instruction joins it. The held brief then waits until its sender has been quiet for as long (`settleHeldBrief`), and the joined brief is read whole for drafting. |
| 2 | After a requester's change started the next draft, the bot said nothing until the draft reached the office. | ChatInbox answers `requester-revision` once: "Got it. I'm making those changes now; the office checks the new draft before it comes to you." (`INBOX_MESSAGES.changeTaken`). |
| 3 | A request that opened for a designer was named "Directive (make me a nice poster…)" to the requester, and every name was its first line verbatim: "I'm making a first draft of Hi, we need a poster for the …". | A design is named by its first line without the greeting and the request around it ("Poster for the KAAE graduation ceremony", "KAAE staff football tournament, 14 November…", "Invitation card for the KAAE annual conference"); a designer's request by its first line like any other. |
| 4 | Sorani deadlines in words ("by next Thursday", "we need it on Saturday") were asked "change or new?". | Sorani weekdays, "next week", "end of the week" with "by / before" or with "we need it" read as a deadline. |
| 5 | "This one is for Nova, not KAAE: …" opened for KAAE and was drafted in KAAE's brand. | An organisation the words say it is not for ("not X", "instead of X", Sorani "not X") names no client. |
| 6 | A reply to the delivered file or its notice was not linked to the design (those marks are keyed by task and approval): "can you change the date?" was asked "Is this for …? Just say yes". A reply to a bot message of a design delivered days ago got "I don't have a design in progress here to change". | A reply to a Delivery message binds to that task's request (`replyBindings`, `lateChangeTargets`). Words bound to a design no longer on the way go to the office ("I've passed your message to the office"). |
| 7 | "never mind, cancel it" and "no need anymore, thanks" were asked "change or new?". | A cancellation said among filler clauses ("no", "sorry", "thanks", "never mind"), and "no need (anymore)", read as a cancellation. |
| 8 | "??", "hello??", "why is it taking so long??", "this is useless, where is my poster???" were answered with the welcome ("Hi! What would you like designed?"). After an hour the status still said "the draft usually takes a few minutes". | These read as status questions. Asked about a design still being made after 30 minutes, the requester hears "*T* is taking longer than usual. I've asked the office to look into it; they'll follow up here." and every office member is told. |
| 9 | "how much does a poster cost?", "do you have our logo already?", "can you make videos?" were answered with a prompt for a brief; Sorani "how much is a poster?" opened a design request. | A question the bot cannot answer goes to the office: "I can't answer that myself, so I've passed your question to the office; they'll reply here." (or "kept" with no office chat). A price question naming a design is not a request for one. |
| 10 | An office member with a design of their own on the way wrote "ok send it when it is ready" with no reply, and the one waiting draft of another requester was approved and sent. | With no reply, such a member's approval or rejection names the waiting draft and asks ("Which draft do you mean? 1. …"), even when there is one; their "cancel that" is read as about their own design. |
| 11 | In a group, "@hawa_office_bot is the poster ready?" got no answer, and "@hawa_office_bot KAAE members evening …" put the bot's name in the brief's copy and its name. | A bot's @-mention is taken out of the words before they are read or used (it still marks the message as addressed). |
| 12 | In a group, any member could change or cancel another member's request opened from plain words (the requester was read only from a photo or album brief's stored update). | A request's requester is also read from the decision that opened it (the intent receipt's sender), so ADR-144's group ownership rule holds for text briefs. |
| 13 | A short complete brief ("Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium", a Sorani brief with a date in Sorani months) went to a designer by hand while a longer one was drafted. | A request that names its event with a date or a time is drafted as a longer one is; dates in Sorani (Iraqi and Kurdish month names, slashes, "کاتژمێر" hours, either digits) count. |
| 14 | An edit of "thanks" into "thank you" was thanked again. | An edit read again as thanks says nothing. |
| 15 | Office member told "… the requester has your note" (lower case at a sentence start). | "I have sent your note on *T* to {requester}". |

### 2.3 What the requester hears (new lines)

| When | English | Sorani |
|---|---|---|
| change started | "Got it. I'm making those changes now; the office checks the new draft before it comes to you." | "تێگەیشتم. ئێستا ئەو گۆڕانکارییانە دەکەم؛ ئۆفیسەکە پێش ئەوەی ڕەشنووسە نوێیەکە بۆت بێت سەیری دەکات." |
| slow design | "*T* is taking longer than usual. I've asked the office to look into it; they'll follow up here." | "*T* لە ئاسایی زیاتر دەخایەنێت. داوام لە ئۆفیسەکە کرد سەیری بکەن؛ لێرە وەڵامت دەدەنەوە." |
| question passed / kept | "I can't answer that myself, so I've passed (kept) your question to (for) the office; they'll reply here." | "ناتوانم خۆم وەڵامی ئەوە بدەمەوە، بۆیە پرسیارەکەتم گەیاندە ئۆفیسەکە (بۆ ئۆفیسەکە هەڵگرت)؛ لێرە وەڵامت دەدەنەوە." |

Every Sorani line is marked in `plans/lean-design-implementation-2026-09-28/SORANI_REVIEW.md` ("ADR-182"), with the reworded office line `office.sentBack`; none has had a native review. The Sorani words the rules now read (weekdays, months, question and price words) are listed in `requester-turn.ts`.

## 3. Cost

No model call is added: every repair is rules, a join or a message. Fewer paid drafts start: a typed brief opens one request instead of two, and its tail is no longer a separate paid draft. One routing change can start a paid draft where a designer worked by hand before: a short request that names its event and its date or time (repair 13), and a typed brief that is complete once its parts are joined (repair 1), are drafted automatically, exactly as the same words sent in one longer message always were (one draft per request, the office's daily allowance, `AUTO_GENERATE_CHAT_DESIGNS`). A request without copy ("make me a nice poster") still goes to a person.

## 4. Safety rules kept

- No paid round by recency; approval stays with the office (a requester's approval words approve nothing; an office member's words decide only a draft they clearly mean).
- One decision per update: a joined part, an intent receipt and every answer replay word for word; the change-taken notice has a stable key.
- In groups only a request's requester or the office changes it, now for text briefs too.
- Nothing untrue: "kept" only where kept; "the office was told" only when an office chat was alerted.

## 5. Left open (scripts marked `open`)

- **Two designs in one message** (S022: "We need 2 designs: a poster for … and an Instagram story for …"): one request whose automatic draft is one design. Natural: two requests, or a designer who is told.
- **"wait, don't make it yet"** (S086): kept as an added change; the automatic draft carries on. Natural: the office is asked to hold it.
- **A forwarded brief named after its date line** (S031a): "Please make a poster for the KAAE accreditation workshop" + "Date: 22 November …" is named "Date: 22 November 2026, 10 am" (the name comes from the copy after the instruction).
- Not scripted as defects but seen: a change sent a minute after a round started is a note the new draft does not include (ADR-144 by design); with two designs on the way twenty minutes apart, an unnamed change is kept on the newer one (ADR-144 recency for notes), where a person might ask; "Is this a change to *T*, or a new design? Just say “change” or “new”." still suggests the two words; a colleague's addressed change in a group is ignored silently; a voice note's transcription path is exercised only up to "type the words" (KAAE's privacy does not admit cloud transcription in the test data); the office's text draft alert (when its picture cannot be read) still says to decide in Hawa Desk.

## 6. Verification

- `apps/core/test/natural-language-stress.test.ts`: 121 scripts; 118 pass and the 3 `open` scripts fail as expected. Red first: with the same harness and scripts against production's source (`36369a12`, the source diff reversed in place), 40 of the 118 fail (S002, S010, S013, S014, S019, S023-S031, S034, S036, S039-S045, S055-S058, S081, S083, S090-S092, S098, S099, S118, S119, S128, S131, S133, S134); the other 78 pin behaviour that was already natural.
- `apps/core/test/requester-turn-adr182.test.ts` (41 tests): the rules behind the repairs (it cannot load against production's source: the helpers are new).
- `apps/worker/test/chat-inbox.test.ts` (+1): the change-taken notice, once per update, in the requester's language (fails before).
- `apps/core/test/lifecycle-internal-intake.test.ts`: "what fonts can you use?" moved from the prompt-for-a-brief row to a test of its own that passes it to the office (fails before).
- A Telegram split or forwards joined to a held brief still open it at its first settle (ADR-156's tests unchanged); only typed parts (`typed: true` on the part) make the brief wait for its sender to be quiet.
- `apps/core`, `apps/worker` and `packages/integrations` (329 files): 3,635 passed, 3 expected fail, 4 skipped, 4 failed; the 4 were the two ADR-156 split tests (fixed by the `typed` mark above), the changed question row (above) and CV-17's bundle check, which needs a Desk build in a fresh worktree (passes after `vite build`); all four files pass on a rerun. `pnpm typecheck` (644 test roots) and `pnpm lint` pass.
- Not run: chaos (shared and locked), live Telegram, a real intake-router reading, a native Sorani review.
