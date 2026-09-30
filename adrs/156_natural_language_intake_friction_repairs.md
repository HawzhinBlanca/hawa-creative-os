# ADR-156: Natural-Language Intake Friction Repairs (audit of 2026-09-30)

**Date:** 2026-09-30
**Status:** Implemented and locally tested on branch `claude/fix-intake-nl` (from production `6bd479c1`); not deployed.
**Requirements:** FR-005 (passive messages become tasks only through an explicit command, mention, Desk action or an approved classifier policy), FR-004 (a repeated source event gives no more than one task), NFR-001 (no acknowledged event is silently lost).
**Changes a foundation:** no. No new table, migration, dependency or paid-call path. Two inbox-ledger kinds are added in `hawa.inbox_events` (`lifecycle_brief_part`, and the existing `lifecycle_photo_held` is now also written for a photo the bot asks about).
**Builds on:** ADR-143 (held briefs and album settles), ADR-144 (requester intent routing, `planTurn`, the intake router's ledger), ADR-145 (natural media, requester wording catalogue), ADR-022 (approval stays in the Desk).
**Number:** 156, reserved for this stream by the lead.

## 1. Context

The audit of 2026-09-30 (seven reviewers, production commit `6bd479c1`) found that requesters who write naturally still met these failures on Core's Telegram intake. The owner's rule is that requesters use natural language only, so each is a defect:

| Audit | What happened |
|---|---|
| #9 | "Please send it again, it didn't arrive", "send it as a PDF", "send it to my email", "higher resolution" contain "send it", so they read as approval: the requester got "Thank you", the office heard nothing. |
| #10 | A brief over 4,096 characters, which Telegram splits into several messages, or several forwards sent together, became two requests: the first paid draft had half the copy. |
| #11 | A photo with a caption skipped ADR-144 routing: a new photo brief became a paid revision of an older design that waited for changes; "use this logo" while a design was made was answered "send me the text". |
| #12 | A photo replying to the requester's own brief, to the bot's first-draft message or to a colleague's message was refused with an untrue "that design is now with the office" while it was still being made. |
| #13 | While a voice note's or PDF's "Is this exactly the text?" waited, almost any later message (a new brief, "also make the background blue", a question) was taken as the confirmed copy; while "Which organisation is it for?" waited, a brief naming a client answered it. |
| #15 | "Invitation card for the graduation ceremony at the hotel, 5 October 7pm, needed by Thursday" read as a deadline only: the brief was dropped or the deadline went to another design. |
| P2 | A revision conflict (409 `STALE_REVISION` and similar) left the requester with no answer at all. `/design …` in a private chat threw the brief away. |
| P3 | A sticker got a greeting; an SVG logo was answered "send it again as a photo"; `image/jpg` was refused; `changeNotStarted` asked the requester to contact the office themselves. |

Audit #14 (group media gating) and ADR-160's caption-limit rework belong to another stream (`claude/caption-limit-hold-v2`), which owns `lifecycle-album.ts`, `lifecycle-photo.ts`, `lifecycle-media-route.ts`, `albums.ts` and the album, caption and group-media parts of the intake route.

## 2. Decision

### 2.1 Requests about the files are passed to the office (#9)

`requester-turn.ts` gains the reading `delivery_request`, checked before approval: "send it again", "resend", "it didn't arrive", "I never received it", "I can't open the file", "as a PDF/PNG/JPG/SVG", "PDF version", "to my email / by WhatsApp", an email address, "high(er) resolution / better quality / hi-res"; Sorani "دووبارە بینێرەوە" (send it again), "نەگەیشت" (it did not arrive), "بە ئیمەیڵ" (by email), "کوالیتی بەرز" (high quality) and a file type named among Sorani words. Words that correct the design instead ("the email should be …", "add my email …", "a higher resolution logo") stay a change.

`planTurn` chooses the design as for any note (reply, only one, named, clearly most recent; delivered designs of the last three days included) and plans a `tell` with note `delivery`. The requester hears "Got it. I've passed your request about *T* to the office; they'll follow up here." (or, with no office chat, that it is kept for the office); the office hears the words, the design and its stage, and that nothing was sent automatically. Nothing is approved and Deliver is not held. With no design listed, the words are forwarded to the office.

### 2.2 A brief sent in several messages is one brief (#10)

`lifecycle-brief-parts.ts`. While ADR-143 holds a sender's text brief for photos, a text of that sender (same chat and topic) that continues it is joined to it (`lifecycle_brief_part`, keyed by its own update, first write wins) instead of being set behind it. It continues the brief when:

- it came within `HAWA_BRIEF_PART_SECONDS` (default 5, at most 30) of the part before it, by Telegram's message dates;
- it is not a reply and not a command; and
- the part before it was at least 3,000 characters long (Telegram splits at 4,096), or both are forwarded messages.

At most 20 parts and 100,000 characters. The joined part is answered with nothing (`briefPart: true`; ChatInbox sends no notice); when the held brief settles and opens, its words are the brief (or its edited words) followed by every part in the order sent. A message of the sender's own right after a brief ("thanks", "urgent please") is still set behind the brief and read after it opens (ADR-145). No paid call is added: the brief opens once, as before.

### 2.3 Photos and albums with words are read as text is (#11, #12)

The intake route's ADR-144 block now takes a captioned photo, a photo sent as a reply with no words, and an admitted album with words, as well as text. The same reading, the same choice of design and the same group ownership (only the request's requester or an office member changes it) apply:

- a new brief with a photo or an album opens its own request with its media, never a round of an older design;
- a change bound for certain to a design that waits for changes is a round with the photo (as before); several open designs are asked about ("Which design is this for?"), and the photo is kept under the question's update (`lifecycle_photo_held`, marked asked) so the answer carries it (`waitingPhotos` for a round or a brief; read by update for a note);
- a change for a design still being made (`designing`, or `manual` below revision 3) keeps a note for the office (the late-change store; Deliver waits), and the photo becomes the design's material: added to its task files as a `reference_image` while the design has not started using pictures, by ADR-145's rule (`lifecycle-photo-material.ts`), else left in the chat and the office told where it is. "use this logo" is answered "Got it. I've added that to *T*; the office will see it before the design is sent to you.";
- a photo with no words, replying to the requester's brief, the bot's first-draft message or a colleague's message, is read as material for the design the reply points at (or the only open one): "Got the photo. I've added it to *T*." when it was added, "*T* is already being made, so I've passed the photo to the office to use." when not. It is never answered "that design is now with the office" while being made. Replying to a design that waits for changes, it cannot start a round unless it replies to that design's current revision notice (the projection's rule): it is kept, and asked about, for the words that will;
- words that are chat, or find nothing to change, keep the photo and ask for the words (ADR-145's answer);
- an album whose words would only be asked about goes to the office whole ("I've passed your message to the office"), because its photos cannot follow a later answer (the projection binds an album to the update that admitted it), except that "change or new?" with no design among the choices waiting for changes opens the brief with its photos, as it did before.

A revision photo decided before this change (no intent receipt) replays through the old routing unchanged.

### 2.4 Pending source questions accept only answers (#13)

`lifecycle-source-natural.ts`. While "Is this exactly the text?" waits, the words shown are confirmed only by a confirmation ("yes", "بەڵێ") or replaced only by words that look like the copy: words that repeat much of what was shown, or copy-shaped words that are not a request, a change, a question or chat. A new brief, "also make the background blue", "what fonts do you have?", "send it again", thanks, a status question, a cancel or a deadline is read as any message is, and the words stay unconfirmed. "Which organisation is it for?" takes a plain answer (six words or fewer, not a question or a request) or a `Client:` line; a longer message that names a client is read on its own and the question stays open.

### 2.5 A brief with a deadline is a brief (#15)

A message whose words, without the deadline clause, still name the event with a date or a time (or several event details) is not read as a deadline alone. Where the heuristics would call it chat, it reads as a substantial brief; "we need it by tomorrow", "urgent please" and "the poster for the conference is needed by Thursday" stay deadlines.

### 2.6 A round that could not start is answered (P2)

When a planned round finds its design moved on (the request no longer waits, or the projection answers `STALE_REVISION`, `WRONG_STAGE` or `NOT_CURRENT_DRAFT`), intake reads the chat's requests again and plans the same words once more: a note, a question, a tell or a round on the fresh state. A second miss forwards the words to the office ("I've passed your message to the office; they'll follow up here." and an alert saying why). Any other projection conflict on this path also answers that way instead of staying silent. The daily-cap and missing-brief refusals keep their own answers.

### 2.7 Smaller repairs (P2, P3)

- `/design …`, `/task …`, `/brief …`, `/campaign …` in a private chat open the words after the command as a brief, as in a group (and as `/new …` always did).
- A sticker, or a message with no words at all, is not a greeting: nothing is said (recorded once, `NO_WORDS`).
- An SVG file (by type or name) is passed to the office: kept as a note on the sender's one open design, or forwarded with its name when there is none. The bot does not rasterise it: the design path takes only PNG, JPEG and WebP, and a requester's SVG can reference other files and fonts, so drawing it safely would need a sandboxed renderer this change does not add.
- `changeNotStarted` (no office chat to pass a blocked change to) now says the change is kept for the office and need not be sent again, instead of asking the requester to tell the office.

### 2.8 What the requester hears (new lines)

| When | English | Sorani |
|---|---|---|
| request about the files | "Got it. I've passed your request about *T* to the office; they'll follow up here." | "تێگەیشتم. داواکارییەکەتم سەبارەت بە *T* گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە." |
| SVG, on a design | "Thanks for the logo. I can't place this kind of file myself, so I've passed it to the office to add to *T*." | "سوپاس بۆ لۆگۆکە. خۆم ناتوانم ئەم جۆرە فایلە دابنێم، بۆیە گەیاندمە ئۆفیسەکە بۆ ئەوەی بۆ *T* زیادی بکەن." |
| SVG, no design | "Thanks for the file. I can't place this kind of file myself, so I've passed it to the office; they'll follow up here." (no office chat: "… so I've kept it for the office; …") | "سوپاس بۆ فایلەکە. خۆم ناتوانم ئەم جۆرە فایلە دابنێم، بۆیە گەیاندمە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە." / "… بۆیە بۆ ئۆفیسەکەم هەڵگرت؛ …" |
| change not started | "I couldn't make this change by myself just now, so I've kept it for the office; they'll follow up here. There's no need to send it again." | "ئێستا نەمتوانی خۆم ئەم گۆڕانکارییە بکەم، بۆیە بۆ ئۆفیسەکەم هەڵگرت؛ لێرە وەڵامت دەدەنەوە. پێویست ناکات دووبارەی بنێریتەوە." |

Every Sorani line above is new and marked in `plans/lean-design-implementation-2026-09-28/SORANI_REVIEW.md` ("new or reworded in ADR-156"); none has had a native review. The Sorani words the bot now reads for file requests are listed in `requester-turn.ts` beside the others awaiting review.

## 3. Cost

No design is started by anything in this change that did not start one before; several things that started a paid round before no longer do (a photo brief beside a waiting design, an album with short words beside one, a split brief's tail).

The only model call that can newly occur is ADR-144's intake router for a **captioned photo or an album with words** whose words the rules cannot place (the `unclear` remainder that would otherwise be asked about). It is the same call, not a new one: `intentModel.read` keyed by the Telegram update, so admission is the same insert into `hawa.requester_intent_calls` (one row per tenant and update; a replay reads the stored decision and never calls again), under the same `intake_router` spending role, the same shared daily allowance (`admit_office_spending`), the same consent, key and egress checks, and the same reservation (about $0.023 typical and a $0.10 reservation at the production text model's rates, ADR-144 §2.3). A photo with no words never reaches the model (its reading is fixed as a change). File requests, brief joins, SVG files, stickers and the conflict answer use no model.

Photo downloads for a kept photo are Telegram file downloads, not paid calls.

## 4. Safety rules kept

- No paid design without an instruction bound for certain; recency never starts a round; a photo with no words starts one only as a reply to that design's current revision notice.
- One decision per update: the intent receipt, the late-change record, the kept-photo claim and the brief-part record each replay word for word; the same photo is used once.
- In groups only a request's requester or the office changes it, for photos and albums as for text.
- Approval stays in the Desk; a file request approves and sends nothing.
- Nothing said is untrue: no "with the office" while a design is being made; "kept for the office" only where the words are kept.

## 5. Limits and cross-stream notes

- **`image/jpg` is not fixed here.** The MIME check is `lifecycleStillImageFile` in `apps/core/src/services/lifecycle-photo.ts`, owned by `claude/caption-limit-hold-v2`. The exact change: add `'image/jpg'` to the document `mime_type` list beside `'image/jpeg'` (the bytes are sniffed afterwards, so nothing else changes).
- **Brief parts and albums.** When an album consumes a held brief (`lifecycle-album.ts`, the other stream), the album takes the brief's own words only. It should append `briefParts(trx, tenant, heldUpdateId)` with `joinedWords` from `lifecycle-brief-parts.ts`.
- **An album asked about** goes to the office rather than carrying its photos to the answer (§2.3); carrying it would need the album projection to accept an album admitted under an earlier update.
- A split part that arrives after the held brief has settled (15 s by default), or when the worker does not send `briefHold`, is read on its own, as before.
- A "yes" meant for a routing question can still confirm a pending voice note's or PDF's words when both are open (unchanged; source replies are read first).
- `revise` plans replanned after a conflict may start a round on the fresh state only by `planTurn`'s own certainty rules.

## 6. Verification

- `apps/core/test/requester-intake-friction-adr156.test.ts` (37 tests; the audit-intake probes `intake-friction.probe.ts` and `approval.probe.ts` as rules, and the route against the per-file test database as `hawa_app`): file requests in English and Sorani after delivery and in review, with no Deliver hold; change-shaped email and logo words; a brief with a deadline with and without an open design; source replies and client answers; brief continuation; a split brief and forwards joined into one request, the sender's own message still set behind; a photo brief and an album brief beside a waiting design; short album words beside it; "use this logo" while designing (task file, office alert); a colleague's photo in a group; photo replies to the own brief, the first-draft message and a colleague's message; a photo once the design uses pictures; `/design` in a private chat; a sticker; SVG files with and without an open design; the reworded `changeNotStarted`.
- `apps/core/test/requester-revision-conflict-adr156.test.ts` (2 tests): the projection is made to answer `STALE_REVISION`; the replan keeps a note on the design that moved on, and a second miss forwards to the office.
- `apps/core/test/lifecycle-source.test.ts` (+2): new brief, change and question while a PDF's words wait; a brief naming the client while "Which organisation?" waits.
- Changed deliberately in `apps/core/test/lifecycle-internal-intake.test.ts` (3 tests): a captionless photo replying to an unknown message or an older notice is kept and asked about instead of the untrue stale-reply answer; a captioned photo with two designs waiting asks which one and keeps the photo (one download) instead of refusing.
- Red first: against production's source (`6bd479c1`), the new route and rule tests fail (28 of 37 in the new file with its imports satisfied; the 9 that pass guard readings that must not change or test the new helpers), as do both conflict tests, both new source tests and the 3 changed expectations. Green after: 28 affected test files, 882 passed, 1 skipped. `pnpm typecheck` (603 test roots) and `pnpm lint` pass.
- Not run: the full suite, chaos (shared and locked), live Telegram traffic, a real intake-router reading, a native Sorani review.

## 7. Addendum (integration, 2026-09-30): cross-stream items

Done on `claude/integrate-audit-fixes` after merging this branch with `claude/caption-limit-hold-v2` (ADR-160) and `claude/fix-durability` (ADR-155):

- **Group albums after the merge.** Section 2.3 reads an admitted album through `planTurn`, which looked for the bot's mention in the album's frozen message. That message keeps the words but not their entities, so in a group an album bound by "@bot use these for …" read as un-addressed and was kept as a passive message (`MESSAGE_ONLY`). ADR-160's gate (`actsInGroup`, at the settle or the bind) already decided that the album acts, so an admitted album now counts as addressed. Ownership and the section 2.3 media rules are unchanged, and un-addressed group media stays passive. No test expectation was changed.
- **`image/jpg`** (section 5) is in `lifecycleStillImageFile`'s document list. The bytes are still sniffed.
- **Brief parts and albums** (section 5). When an album's settle takes a held brief, the brief's words are followed by the parts joined to it (`briefParts`, `joinedWords`). A split brief followed by an album opens one request with all of its copy.
- **Office alerts at intake** (handed off by ADR-155 section 6). Intake's alerts (late changes, notes and forwards, blocked changes, SVG files, edits, parked updates) went to the first office member only, and to nobody when that member was the requester. `office-chats.ts` names the first member other than the chat the words came from. The route's answer adds `officeAlerts` (the same alert for every other member, with `officeAlert` still the first), and a parked update writes one outbox alert per member. The worker's ChatInbox sends each alert under `officeAlertKey`, so the first keeps the key it always had and nothing sent before is sent again. A Core without `officeAlerts` still works with an older worker, and the other way round.

Tests: `apps/core/test/intake-cross-stream-adr160-156.test.ts` (8; 7 fail with the Core sources before these changes; the 8th tests the new helper), `apps/worker/test/chat-inbox.test.ts` (+1, which fails before), and `apps/core/test/lifecycle-album-caption-limit.test.ts` F6-groups, which failed on the merge and passes now. Also run: `apps/core`, `apps/worker`, `packages/integrations` and `packages/contracts` (3,385 passed, 4 skipped), `pnpm typecheck` and `pnpm lint`. Not run: chaos, live Telegram.

## 8. Addendum (2026-09-30): an album's photos are material too

With ADR-160's photo bursts (section 6 of that ADR), photos sent one by one become an album. Section 2.3 made a captioned photo, sent with change words for a design still being made (`designing`, or `manual` below revision 3), that design's material; an album with such words only told the office that photos were "in the Telegram chat". An album (or a burst) admitted with change words for such a design now adds each of its photos to the design's task files by the same rule (`addPhotoMaterial`: while the design has not started using pictures, else none is added), and the office note says "[The requester sent N photos with this. They were added to the design's files.]". Nothing else about the routing changes. A burst with no words sent right after its sender's brief is material by ADR-145's five-minute rule, with one answer for the set (ADR-160 section 6.2).

Test: `apps/core/test/lifecycle-photo-burst.test.ts` (a burst with change words for a design being made: both photos are task files and the words are one note; and the wordless burst after a brief). Branch `claude/fix-photo-burst`, not deployed.
