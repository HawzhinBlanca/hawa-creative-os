# ADR-144: Requester Intent Routing

**Date:** 2026-09-29
**Status:** Implemented and locally qualified on branch `nl-routing`; not deployed.
**Requirements:** FR-005 (passive messages become tasks only through an explicit command, mention, Desk action or an approved classifier policy).
**Changes a foundation:** no. It adds one paid-call ledger (`hawa.requester_intent_calls`, migration 068) under the existing `intake_router` spending role of ADR-096, and extends the late-change store of finding 13 to a design that is still being made.
**Builds on:** ADR-135 (every Telegram request takes the lifecycle path; Core's internal intake decides, ChatInbox speaks), ADR-140 (thanks and receipts open no request), ADR-139 (one request per language), ADR-022 (approval stays in the Desk), ADR-096 (one shared daily allowance), finding 13 of the Phase 4 review (late requester changes are kept and gate Deliver).
**Number:** ADR-142 was unclaimed on every branch and in every worktree on 2026-09-29; ADR-143 is the album agent's. The lead assigned 144.

## 1. Context

The natural-language friction audit of 2026-09-29 (`plans/lean-design-implementation-2026-09-28/NATURAL_LANGUAGE_FRICTION_AUDIT.md`) found that Core's intake bound a message to a request before it knew what the message meant:

- While one design waited for changes, every unlinked message was that design's revision. "thanks", "👍", "/status" or a new brief started a paid round (F1, F2).
- With two designs waiting, every message was refused: "reply directly to the revision notice" (F3).
- While a design was being made, a correction opened a second request, and a reply to the bot's "Request received" was refused as a stale reply (F4).
- "looks good, send it" under the draft was a late change the office had to acknowledge (F7). Approvals, cancels and deadlines written plainly opened new requests (F13).
- In a group, colleagues' chatter opened requests, and any member could revise (F8).
- "Hi, can you make a poster for Nawroz?" got a canned greeting and was dropped (F9). A status question got "reply to the preview"; "cancel that" got a greeting (F10).

The owner's rule: requesters (non-technical, English and Sorani, often mixed) never need commands, reply targets or formats, and a natural message is never refused, dropped or misread. The safety rules stay: no paid design without an actual instruction, no double start, no approval on the owner's behalf, revisions only when the requester actually asks for a change.

## 2. Decision

### 2.1 One place decides what a message means, once, before anything is bound

`apps/core/src/services/requester-turn.ts` (pure: no database, no HTTP, no model) reads every plain text message of a lifecycle chat and plans one action against the chat's live requests. The intake route (`lifecycle-internal.routes.ts`) gathers the context, records the decision, and carries it out. Photos, albums, voice and PDF sources keep their own admission (another change); edited messages and button presses are unchanged.

The context (`requester-turn-store.ts`):

- the chat's requests in `designing`, `awaiting_answer`, `manual`, `in_review`, `approved`, `delivering`, and `delivered` in the last three days, with each request's title, stage, revision, client, question, and the Telegram user who sent its brief;
- what a reply points at: any message the bot sent about a request (the draft, a notice, the "Request received" acknowledgement), the bot's answer to an earlier routed message, the requester's own brief, or an earlier routed message of theirs;
- the question the bot last asked this sender, if it is still open;
- whether the chat is a group, and whether the message is addressed to the bot (a reply to it, an `@…bot` mention, a command).

### 2.2 The reading (rules first)

In this order, on the words without politeness ("ok, sorry, please …", "… thanks"):

| Reading | Examples (English / Sorani) |
|---|---|
| approval | "looks good, send it", "go ahead", "keep it as is", "باشە بینێرە" (OK, send it), "پەسەندە" (approved) |
| acknowledgement | "thanks", "ok", "👍", "Thanks, received!", "سوپاس" (thanks), ADR-140's receipts |
| cancel | "cancel that", "please cancel the poster", "forget it", "we don't need it anymore", "هەڵیبوەشێنەوە" (cancel it) |
| status | "when will it be ready?", "any update?", "is it done yet?", "کەی ئامادە دەبێت؟" (when will it be ready?) |
| deadline | "we need it by tomorrow", "urgent please", "تا سبەی پێویستمانە" (we need it by tomorrow) |
| new brief | a structured brief; "new poster …", "another design"; "Hi, can you make a poster for Nawroz?"; "سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە" (hello, make a poster for Nawroz) |
| change | "the date should be 5 October not 4", "make the title bigger", "also add the phone number …", "Sorry, the date is 5 October", "ڕەنگی باگراوندەکە بگۆڕە" (change the background colour) |
| conversation | greetings, questions about the office, standing rules, commands: answered by `lifecycle-chat-answers.ts` as before |
| unclear | a short brief-like message that could be a new design or a note about a current one |

A reading mixes languages freely; the answer is in Sorani when the message has Arabic-script letters. A request that has no copy yet ("can you make a poster for Nawroz?") opens as instruction-only, for a person, never as a paid draft.

### 2.3 The intake router, for what the rules cannot place

Only an `unclear` message that the rules would otherwise ask about is read by a model (`requester-intent-model.ts`), at most once per Telegram update:

- the model is `resolveModel('text')`; the body is priced by `reserveStudioText` before it is sent;
- it is sent only with an OpenAI key, when every candidate request belongs to one client whose egress policy and active DNA both admit OpenAI for client messages (the voice transcription test), and only if the shared daily allowance admits the reservation under the `intake_router` role. Admission is the insert into `hawa.requester_intent_calls` (migration 068, trigger `enforce_requester_intent_call` → `admit_office_spending`). The budget line charges a call its usage when known and its whole reservation otherwise, so an interrupted call never leaves the office history incomplete (the ADR-133 failure);
- one row per `(tenant, update_id)`: a replay finds the row and uses its stored decision, and a row whose outcome was never recorded is no decision (the requester is asked). It never calls twice;
- the model can say `change` (naming a listed design), `new_design`, `other` or `unsure`, with a confidence. A named design is accepted for a note at 0.6 and for a paid round only at 0.85; `new_design` and `other` at 0.8. Anything else keeps the question.

**Cost.** Deterministic rules cost nothing, and decide thanks, emoji, status, approvals, cancels, deadlines, corrections, change requests and briefs. A model reading is paid only for the unclear remainder. The request body for two candidate designs is about 1.4 KB. Priced by `reserveStudioText` and `studioTextUsage` at the reservation table's `gpt-6-astra` rates ($22.50 per million input tokens, $50 per million output tokens): a typical reading (about 450 input and 250 output tokens, low reasoning effort, `max_completion_tokens` 400) costs about **$0.023**, and the admitted reservation is **$0.10** (3,592 input and 400 output tokens, conservatively), released to actual usage when the call completes. On the development tier (`gpt-4.1-mini`) a reading costs about $0.0006 (reservation $0.002). Messages the rules decide cost $0.

### 2.4 Choosing the request

For a change, cancel, approval or deadline: the request the message replies to; else the only candidate; else the one whose title the words name; else the model's pick; else, for notes only, a request clearly more recent than the rest (ten minutes of activity apart). Otherwise the requester is asked. Recency never starts a paid round.

### 2.5 What each reading does

| Reading | Target stage | Action | Paid? |
|---|---|---|---|
| change | waits for changes (`manual`, rev ≥ 3) or `awaiting_answer` | a revision round, or the answer to the question (as before) | yes, only here |
| change | `designing`, `manual` (rev < 3) | kept on the request as a pending change; the office is alerted; Deliver waits until an office member reads it | no |
| change | `in_review`, `approved`, `delivering`, `delivered` | a late change (finding 13), in plainer words | no |
| cancel | any open stage | kept on the request with kind `cancel`; the office is asked to cancel; Deliver waits | no |
| approval | any open stage | the office is told the requester is happy; nothing is approved (ADR-022); Deliver is not held | no |
| deadline | any open stage | the office is told | no |
| status | all, or the one replied to | answered from the stage | no |
| acknowledgement | — | thanked; with one design waiting, reminded what to do | no |
| new brief | — | a request opens (instruction-only when it has no copy) | only as before |
| conversation | — | `lifecycle-chat-answers.ts` | no |

A full brief opens beside open designs, unless it repeats the words of one that waits for the requester's changes (possibly its corrected copy): then the requester is asked "change or new?".

A reply to a bot message that no current request knows (an old draft of the deleted intake, a finished request's notice) is about another design. It is never applied to a current request by itself: with current requests the requester is asked which one they mean; with none, the words go to the office.

### 2.6 One question, answered in words

When the target is genuinely ambiguous, the words are kept on the question's record and the bot asks once:

- "Which design is this for? 1. *A* 2. *B* … Answer with the number or the name." (with "N. A new design" when a new design is possible);
- "Is this a change to *A*, or a new design? Just say “change” or “new”.";
- "Is this for *A*? Just say “yes”."

The sender's next message answers it when it is a number (ASCII, Arabic-Indic or Persian digits), an ordinal ("the second one", "دووەم" second), "last", "new"/"a new one"/"نوێ" (new), "change"/"yes"/"بەڵێ" (yes), or a design's name in a short answer; or when it replies to the question itself. A reply to another design's message, thanks, or a longer message is read on its own, and the next routed message of that sender closes the question. The kept words are applied under the answer's own update ID (its revision key, sibling and open receipts are the answer's), so nothing starts twice.

### 2.7 Groups

In a group, only a message addressed to the bot (a reply to it, an `@…bot` mention, a command) or a clear brief (said to be new, or with a divider or a copy heading) acts. Other conversation stays passive (`MESSAGE_ONLY`). Words bound to another member's request stay passive: only a request's own requester (the sender of its brief) or an office member (`TELEGRAM_ALLOWED_USERS`) changes it. A group's `/task …`, `/brief …`, `/design …` and `/campaign …` open a request as `/new` does (they asked for `/new` before).

**BotFather privacy mode** is not recorded anywhere. With privacy mode on, the bot receives only commands, mentions and replies to it in a group, which is exactly what acts under this rule; with it off, it receives everything and the rest stays passive. Either setting is safe; recording it is left to the office runbook.

### 2.8 Decided once; replayed word for word

Every routed text message records its decision under its update ID (`hawa.inbox_events`, account `lifecycle_chat_intent`) before any side effect: the reading, the plan and, for a plan that only answers (thanks, status, a question, an approval or deadline note, a forward), the exact intake answer. A kept change records its late-change row and the intent row in one transaction. A replay:

- returns a recorded answer word for word (`duplicate: true`; a late change exactly as first answered);
- re-executes a recorded open or revision plan, whose own receipts (the open decision, the revision projection key) make it idempotent;
- refuses the same update ID with different words (`IDEMPOTENCY_CONFLICT`).

ChatInbox journals Core's answer in Restate (`intake-<k>`) as before, and its notices are keyed by the update. The intent and the model's confidence ride in the answer (`intent`), so the journal shows what was decided.

A follow-up read before RequestLifecycle projects a request that intake just decided to open would miss it. While such an open is in flight (decided in the last ten minutes, not projected), a follow-up other than thanks, chatter or a brief said to be new is answered `503 REQUEST_OPENING`; ChatInbox tries again in 2 s (a counted retry).

### 2.9 What the requester hears (new strings)

Core supplies the words, in the requester's language, as `chatAnswer` (and `officeAlert` for the office chat, which ChatInbox sends under `notify.office:requester-note:<update>`). **Every Sorani string below is new and needs native review before release.**

| When | English | Sorani |
|---|---|---|
| thanks, one design waiting | "🙏 Thank you.\n\nWhenever you're ready, just tell me what to change on *T*." | "🙏 سوپاس.\n\nهەر کاتێک ئامادە بوویت، پێم بڵێ چی لە *T* بگۆڕم." |
| status, designing | "*T* is being designed right now. The draft usually takes a few minutes; the office checks it before it comes to you." | "*T* ئێستا دیزاین دەکرێت. ڕەشنووسەکە زۆرجار چەند خولەکێک دەخایەنێت؛ ئۆفیسەکە پێش ئەوەی بۆت بێت سەیری دەکات." |
| status, manual | "A designer at the office is working on *T*. It will be sent here when it is ready." | "دیزاینەرێک لە ئۆفیسەکە کار لەسەر *T* دەکات. کە ئامادە بوو لێرە بۆت دەنێردرێت." |
| status, waiting for changes | "*T* is waiting for your changes. Just tell me what you would like changed." | "*T* چاوەڕێی گۆڕانکارییەکانی تۆیە. تەنها پێم بڵێ چیت دەوێت بگۆڕدرێت." |
| status, awaiting answer | "*T* is waiting for your answer to one question: *q*" | "*T* چاوەڕێی وەڵامی تۆیە بۆ یەک پرسیار: *q*" |
| status, in review | "*T* is with the office for a final check. It will be sent here once they approve it." | "*T* لای ئۆفیسەکەیە بۆ دوایین پشکنین. کە پەسەندیان کرد لێرە بۆت دەنێردرێت." |
| status, approved / delivering / delivered | "*T* is approved and will be sent to you shortly." / "*T* is being sent to you now." / "*T* has been delivered." | "*T* پەسەند کراوە و بەم زووانە بۆت دەنێردرێت." / "*T* ئێستا بۆت دەنێردرێت." / "*T* گەیەندرا." |
| status, nothing open | "I don't have a design in progress in this chat right now. Tell me what you'd like designed." | "ئێستا هیچ دیزاینێکم لەم چاتەدا لە دەستدا نییە. پێم بڵێ چیت دەوێت دیزاین بکرێت." |
| change while being made | "Got it. I've added that to *T*; the office will see it before the design is sent to you." | "تێگەیشتم. ئەوەم بۆ *T* زیاد کرد؛ ئۆفیسەکە پێش ناردنی دیزاینەکە دەیبینێت." |
| change, in review / approved | "Got it. The office is checking *T* now, and I've passed your change to them." | "تێگەیشتم. ئۆفیسەکە ئێستا سەیری *T* دەکات، و گۆڕانکارییەکەتم پێیان گەیاند." |
| change, delivering / delivered | "*T* is being sent to you now; I've passed your change to the office." / "*T* was already delivered; I've passed your change to the office." | "*T* ئێستا بۆت دەنێردرێت؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە." / "*T* پێشتر گەیەندرابوو؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە." |
| cancel | "OK. I've asked the office to cancel *T*." | "باشە. داوام لە ئۆفیسەکە کرد کە *T* هەڵبوەشێنێتەوە." |
| approval | "Thanks! I've told the office you're happy with *T*. They give it a final check before it's sent." | "سوپاس! بە ئۆفیسەکەم ڕاگەیاند کە تۆ ڕازیت بە *T*. پێش ناردن بۆ دواجار سەیری دەکەن." |
| deadline | "Noted. I've told the office about the timing for *T*." | "تێبینی کرا. سەبارەت بە کاتی *T* ئۆفیسەکەم ئاگادار کردەوە." |
| which design | "Which design is this for?\n1. *A*\n2. *B*\n\nAnswer with the number or the name." (+ "N. A new design") | "ئەمە بۆ کام دیزاینە؟ … بە ژمارە یان ناو وەڵام بدەرەوە." (+ "دیزاینێکی نوێ") |
| change or new | "Is this a change to *T*, or a new design? Just say “change” or “new”." | "ئەمە گۆڕانکارییە لە *T*، یان دیزاینێکی نوێیە؟ تەنها بنووسە «گۆڕانکاری» یان «نوێ»." |
| is it this one | "Is this for *T*? Just say “yes”." / cancel: "Do you want me to ask the office to cancel *T*? Just say “yes”." | "ئەمە بۆ *T*ە؟ تەنها بنووسە «بەڵێ»." / "دەتەوێت داوا لە ئۆفیسەکە بکەم *T* هەڵبوەشێنێتەوە؟ تەنها بنووسە «بەڵێ»." |
| nothing to change | "I don't have a design in progress here to change. Tell me what you'd like designed, with the text that should go on it." | "ئێستا هیچ دیزاینێکم لە دەستدا نییە بۆ گۆڕین. پێم بڵێ چیت دەوێت دیزاین بکرێت، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت." |
| words about an old design | "I've passed your message to the office; they'll follow up here." (no office chat: "I've kept your message for the office; they'll follow up here.") | "پەیامەکەتم گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە." / "پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت؛ لێرە وەڵامت دەدەنەوە." |

ChatInbox's own notices lose their refusals and reply demands (used for photos with two designs waiting, button presses, `/new` with nothing after it, and replays of older late changes):

| Notice | English | Sorani |
|---|---|---|
| two designs waiting (photo) | "More than one of your designs is waiting for changes. Which one is this for? Just tell me its name." | "زیاتر لە یەک دیزاین چاوەڕێی گۆڕانکارییەکانی تۆن. ئەمە بۆ کامیانە؟ ناوەکەی بنووسە." |
| stale button or reply | "That design is now with the office. If anything should change, just tell me here." | "ئەو دیزاینە ئێستا لای ئۆفیسەکەیە. ئەگەر شتێک پێویستی بە گۆڕین هەیە، لێرە پێم بڵێ." |
| nothing after `/new` | "What would you like designed? Tell me in your own words, with the text that should go on it." | "چیت دەوێت دیزاین بکرێت؟ بە وشەی خۆت پێم بڵێ، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت." |
| answer taken (Sorani only is new) | (unchanged) | "سوپاس، ئەوە بەکاردەهێنم و هەمان دیزاین تەواو دەکەم." |
| late change, no words from Core | "Got it. The office is checking this design now, and I've passed your message to them." / delivering, delivered variants / no office chat: "Got it. I've kept your message for the office; they'll see it before the design is sent." | matching Sorani lines in `chat-inbox.ts` |

The office's alerts (English): a kept change or cancel names the design and the stage ("… sent a change for the design "*T*" while it was still being designed. It was not applied to any design; fold it into the next round or the review." / "… asked to cancel the design "*T*" … Nothing was stopped automatically."); approval ("… says they are happy with "*T*". Nothing was approved: approval stays in the Desk."); deadline; and words about an old design. Each quotes the requester's words.

## 3. Safety rules kept

- **No paid design without an instruction.** Only a change bound for certain to a request that waits for changes (or answers its question) starts a round; a request with no copy opens for a person. Thanks, emoji, status, approvals, cancels, deadlines and questions never start work.
- **No double start.** One decision per update; the revision and open receipts are keyed by the update that carries them out; a question's answer applies the kept words under the answer's own ID; the model is called once per update.
- **No approval on the owner's behalf.** Approval words are a note to the office (ADR-022); the Desk still approves.
- **No misrouted revision.** A reply to a design binds to it; a reply to an unknown bot message is never applied unasked; recency never starts a round; in groups only the requester or the office changes a request.
- **Nothing is dropped.** Every change, cancel, approval, deadline and forwarded word reaches the office or the question's record.

## 4. Consequences

- The requester is never told to reply to a message, send `/new`, or use a format on the text path.
- A cancel does not stop a design run already started (RequestLifecycle has no cancel transition); the office acts on it, and Deliver waits until an office member has read it.
- A pending change made while a design is being made is not folded into that run: the office sees it at review (Deliver is held until someone reads it) and asks for the round. Folding it automatically needs a RequestLifecycle change.
- The Desk's late-change dialog still says the words came "after this design reached the office", also for pending changes. The Desk's call-cost page does not list intent calls (the budget counts them).
- Mixed deployments: an older worker would reject a late change at a new stage (it waits and retries) and would not send an office alert attached to a chat answer. Core and the worker ship together.
- Media admission (voice, PDF, HEIC, captionless photos), album settling (ADR-143), edited messages, the allowlist silence (N5) and the bulk wording pass are other changes.

## 5. Verification

See the traceability row FR-005 and §5 below (filled in when the runs finish).
