# ADR-200: The Office Chat Is Read Like a Chat

**Date:** 2026-10-01
**Status:** Implemented and tested on branch `claude/office-chat-understanding` (from production `1ba5bda9`); not deployed.
**Requirements:** FR-043 (only the office approves or rejects a design), FR-062 (paid model calls are limited by office and client scope), NFR-016 (an office operator does routine work without a command line).
**Changes a foundation:** no. It reuses ADR-144's intake-router ledger with no schema change and adds no dependency.
**Builds on:** ADR-040 addenda (office decisions in Telegram, draft choice, pending-choice re-read), ADR-144 (intake router), ADR-182 (natural-language stress suite).
**Number:** 200, reserved for this stream by the lead.

## 1. Context

The owner wrote on 2026-10-01: "the chat from telegram should work like a chat and model will understand if its feedback, revision, normal speech, another task or what". The owner rule is natural language only, for everyone, with no required reply targets or formats.

The office turn (`apps/core/src/services/office-telegram-turn.ts`) read an office member's words with keyword rules only. This morning those rules read "the design is not approved, …" as approval; `1ba5bda9` fixed that sentence, but the reading stayed rules-only. It could not tell "the Sewa one looks good" from a brief, did not know "the other one" meant the draft it had just named, and an approval sent a draft to its requester at once.

## 2. Decision

### 2.1 A model reads what the rules are not certain about

`office-intent-model.ts` asks `resolveModel('text')` (the requester router's tier) what an office member's words mean: approve, change (with the change words), reject, a question about a draft, a new design of the member's own, chat, or unclear; and which listed draft they are about. It is asked only when all of these hold:

- drafts are waiting for review;
- the rules are not certain. Certain means: a reply to a draft's picture that clearly decides; words that clearly decide about the only waiting draft or the draft the bot was just talking about; a brief of the member's own; thanks;
- an OpenAI key is configured and every waiting draft's client admits OpenAI (its titles and requester names are in the request);
- the office's shared daily allowance admits the call (role `intake_router`).

The request carries the waiting drafts (title, when sent, photo count, who asked, which picture this member saw last), the member's last messages and the bot's last answers in this chat (design names that are not waiting drafts, and requesters' quoted words, are left out), and what the message replies to. Every word from the chat is marked as data, never instructions.

### 2.2 The model is advice; the rules gate

- Words the rules read as a refusal, a change or a rejection are read by the rules, whatever the model says. The incident sentence is a change even when the model says approve.
- The model alone never rejects: it asks what to do with the draft.
- A question about no particular draft ("is my poster ready?") is left to intake.
- A member with designs of their own on the way: the model's pick never sends their change or cancellation back on someone else's draft (ADR-182 guard); intake places it.
- An approval executes only with words that only approve (`unambiguousApproval`: no refusal, negation, question or change) and a certain draft (a reply, the only one waiting, the one the bot just asked about, a choice from the list). Anything else becomes a question, never an approval.
- A new design or chat is left to intake, as before.
- When the model is off, fails, answers nothing, or the allowance refuses, the rules decide alone. The turn records `reading: { source: 'rules', consulted: true }`.

### 2.3 The conversation names drafts

`referencedDraft` reads, without a model: "the other one" (against the draft just discussed or replied to), "the earlier/older one", "the newest/latest one", "that one", "the one for Sewa", "the Sewa one", "Sewa's one", "the one for me", a title word ("the graduation one"), Sorani "the other", "the previous", "X's", and ordinals against the list the bot just showed. A message right after the bot asked about a draft ("Send … now?", "What should I do with …?") is about that draft. The model's pick is used only when nothing deterministic names the draft and it is at least 0.75 sure. A disagreement between the words, the conversation and the model asks "Which draft do you mean?" with ADR-040's list (time, photo count, newest, requester). An answer about a draft the member did not reply to names it first, as ADR-040's addendum does.

Requesters are named by the first name on their own intake decisions (`senderName` on `lifecycle_chat_intent`), when the opening message kept no Telegram update (a typed brief). Group requests stay "the requester".

### 2.4 Confirmation before a draft goes to someone else

When an approval would deliver to a requester who is not the approving member, the bot asks once: "Send *T* to *R* now?" (Sorani in the catalogue). An approval whose words or draft are not certain is asked about too, even of the member's own draft ("Approve *T* and send it to you now?").

- A plain yes sends: "yes", "ok", "sure", "send it", "go ahead", "looks good", "👍", Sorani "yes" / "ok" / "send it", Kurmanji and Arabic "yes".
- A plain no ("no", "not yet", "wait", "cancel it") sends nothing: "OK, I haven't sent *T*. It is still waiting; …".
- Anything else is a new turn about that draft. "wait, change the title" sends it back with those words.
- The question is stamped with the reading rules (`OFFICE_TURN_RULES` is now 3), the request revision and the design revision. It expires after `PENDING_ASK_MS` (30 minutes).
  - A yes after expiry, or under other rules, asks again and sends nothing.
  - A yes after the draft changed approves nothing.
- The requester's late words (ADR-040 addendum, finding 13) are shown first, and "send it anyway" is the confirmation.
- When the requester is the approving member and the words and draft are certain, it sends without asking.
- `HAWA_OFFICE_CONFIRM_SEND` (default `on`). With it `off`, certain approvals send at once, as before; uncertain ones are still asked about.

Groups and forwards never reach the office turn, so they never answer a confirmation.

### 2.5 One call per update, in the shared allowance (no schema change)

The office reading uses ADR-144's ledger and allowance through one shared function (`readOnce` in `requester-intent-model.ts`; the provider call stays in the one file the egress lint allows).

- An office reading is a row of `hawa.requester_intent_calls` as it is. Its `update_id` is the Telegram update id plus 2^52 (`ledgerUpdateId`; Telegram's ids are far below that, and both stay safe integers), so it never collides with a requester reading of the same update. Its reservation JSON is marked `reader: 'office'` with the real `updateId`.
- The insert trigger admits it like any intake-router row: the office, the `intake_router` role and one client scope. The client charged is that of the draft this member saw last, else the newest listed draft. Every listed client must consent, and the office and role totals count the call whichever client carries it. Attribution among clients is therefore approximate when several clients' drafts wait.
- A replay finds the row and uses its stored decision; an outcome never recorded is charged its whole reservation and calls nothing again.
- A migration (a `reader` column, nullable `client_id`) was written first and dropped: Codex's 074–077 are pushed and the runner refuses gaps.
- An office member's update that the office turn leaves to intake can still be read once by the requester router.

### 2.6 What the office hears (new lines)

| When | English | Sorani (needs native review) |
|---|---|---|
| confirmation | Send *T* to *R* now? | ئایا ئێستا *T* بۆ *R* بنێرم؟ |
| confirmation, own draft | Approve *T* and send it to you now? | *T* پەسەند بکەم و ئێستا بۆت بنێرم؟ |
| an old yes | I asked about *T* a while ago, so I haven't sent anything yet. | ماوەیەک لەمەوبەر دەربارەی *T* پرسیم، بۆیە هێشتا هیچم نەناردووە. |
| a no | OK, I haven't sent *T*. It is still waiting; tell me what to change, or say send it when it's ready. | باشە، *T*م نەنارد. هێشتا چاوەڕێیە؛ پێم بڵێ چی بگۆڕم، یان هەر کاتێک ئامادە بوو بڵێ بینێرە. |
| a question about a draft | *T* is from *R*, sent to you *when*, with *photos*. What would you like me to do with it? | *T*: داواکار *R*، *when* بۆت نێردرا، *photos*. دەتەوێت چی لێ بکەم؟ |

All five are marked in `SORANI_REVIEW.md` ("ADR-200").

## 3. Cost

At most one small call per office message, and only when the rules are not certain and drafts are waiting. Measured with the request builder and the reservation policy at production's text model (`gpt-6.1-sol`, low reasoning, 400 output tokens at most):

- a typical request (3 drafts, 4 lines of chat) is 2.8 KB;
- its admission reservation is $0.024, or $0.026 at 5 drafts and 8 lines;
- priced at usage it is about $0.004 to $0.006 (700 input tokens, 60 to 250 output tokens), and at most about $0.01 (1,200 in, 400 out).

These are estimates from the policy's rates. No live call was made. Certain words ("approved" on the only draft, a reply that decides, "thanks", a brief) cost nothing. No design-round cost changes.

## 4. Verification

- `apps/core/test/office-telegram-approval.test.ts`: 127 passed. The 69 earlier tests run with `HAWA_OFFICE_CONFIRM_SEND=off`, which pins the rules as they were. Two expectations now name the requester ("Office", from their own message). The 58 new tests cover:
  - this morning's sentence → change, with a model that says approve;
  - "not this one, the other" with two drafts;
  - "the Sewa one looks good" → confirmation → "yes" → delivered;
  - Sorani;
  - the owner's own "send it" with no confirmation;
  - a confirmation then "wait, change the title" → change, no send;
  - "not yet";
  - expiry and older rules;
  - another revision;
  - model failure and no answer → rules;
  - the model alone never rejects;
  - a question answered with facts;
  - a brief or chat left to intake;
  - group and forwarded "yes" never send;
  - the requester side unchanged;
  - a member with a design of their own on the way (fails with the guard removed);
  - the flag off;
  - 15 reference readings and an ordinal against the shown list, 20 plain-yes readings, request and answer parsing;
  - the real reader against the unchanged ledger: one call per update, its offset key and office mark, counted under `intake_router` and the charged client, a requester row beside it, a provider 500 → rules end to end, a refused allowance → no call and rules end to end, no consent or a mock key → no call;
  - a cost bound.
- Red first: with `office-telegram-turn.ts` and the office catalogue reverted to `1ba5bda9` (stubs for the three new helpers so the file loads), 42 of 126 fail. The own-design guard test was added after this run; it passes on the base, which asks no model, and fails here with the guard removed:
  - 13 of the 15 conversation tests. The owner's own "send it" and the brief/chat case pass on the base, as they should;
  - the end-to-end real-reader test;
  - 28 units: 13 references, the ordinal, the 13 plain yeses and the flag.
- `apps/core/test/natural-language-stress.test.ts`: 14 new office scripts (S137–S150, `fixtures/nl-scripts/office-chat.ts`), with a fixture office reading in the harness. S123–S125 now expect the confirmation. In the harness a private chat's id is now its person's id, as in Telegram.
- `apps/core`, `apps/worker` and `packages/integrations` together: 331 files and 3,875 tests passed, with 3 files and 4 tests skipped. That run had a Desk `vite build` in place, which CV-17's bundle-size test reads. `pnpm typecheck` (653 test roots) and `pnpm lint` pass.

## 5. Limits and open points

- **Ledger key.** Office rows are recognised by the 2^52 offset and the reservation mark, not by a column. A later migration may add a proper reader column and move them.
- **Owner wording left as it was.** Two office lines still name a reply target: the draft alert's last line (`office.draftAlertDecide`, ADR-180) and `office.lostTrack` (ADR-040 addendum). Both were the owner's own wording, and the turn no longer needs a reply. Changing them is for the owner.
- **Not tested.** No live Telegram, no real model call, no native Sorani review.
- **Requester names.** Not known for group requests, or for requesters who have not written since this is deployed. Those drafts are "the requester", as before.
- **Shared allowance.** Office readings share the `intake_router` role allowance with requester routing. A busy office day counts against both.

## 6. Addendum (2026-10-01): redo words

**Branch:** `claude/redo-understanding` (from production `53593d2c`); not deployed. No migration (Codex holds 074–077), no new dependency, no change to the design engine.

### 6.1 Incident

At 08:44Z the owner received the final KAAE K-12 Pilot Study design (task 5edca743, request 95eeb08d). The owner is both an office member and a requester. At 12:33Z they wrote, replying to nothing: "do a better design thats similar to earlier ones".

- The office turn left it to intake, correctly: no draft was waiting, and `asksForNewDesign` read "a … design" as a brief.
- Intake read the same words as a new brief (`explicitNew`, instruction only). It opened request 3a4c6ac4 for a designer, titled with the sentence. The reply was "Got it. A designer will make **do a better design thats similar to earlier o…** and send it to you here."
- The model was never asked: the rules were "certain".
- The delivered request was not among the chat's requests for redo at all. Words with no reply cannot start a round by recency (ADR-144), and a delivered design takes no round.

The lead handles request 3a4c6ac4; this change does not touch production state.

### 6.2 Decision

**Redo words.** `readsAsRedo` (requester-turn.ts) reads these as a redo of the requester's most recent design:

- English: "do a better design", "redo it", "redesign it", "make another version", "try again", "start over", "give it another go", "make it better", "similar to the earlier ones", "like the previous designs", "not good, do it again".
- Sorani: "make it again", "make it better", "a better design / version", "another version", "like the previous ones", "not good, redo it".

A redo is read before a refusal ("not good") and before a new brief ("a … design"). It must carry no new copy, date or time, no photo or album, and no status, cancel, hold or file request. "Don't redo it" is not a redo.

Words with a subject of their own may also be a new design: "for the conference", an event word, Sorani "for …", "a new poster". Such words are `or-new`. "Like the earlier ones" with a subject ("a poster for Nawroz like the previous ones") stays a new brief with a style note.

**Which design.** `planRedo` picks:

1. the design the message replies to;
2. otherwise the intake router's pick, when it is at least 0.85 sure;
3. otherwise a design the words name;
4. otherwise the design that moved last, when no other moved within 10 minutes of it.

Candidates are the requester's own designs in any open stage, or delivered within 7 days (`REDO_WINDOW_MS`). The intake route reads 7 days of delivered requests; every other reading keeps its 3 days inside `planTurn`. ADR-144 says recency never starts a paid round. Redo words are the exception: they name "the latest" by their meaning.

- Two close together: "Which one should I redo?" with the numbered names. The answer ("the second one", a name) applies the kept words.
- Maybe new: "Do you mean redo *title*, or a new design?" The intake router is asked first (`plan.intent` unclear, as before). Its request now says when each design last moved, and that redo words are a change to the design they mean. A change reading keeps the redo.
- Nothing recent: the words are read as before. "Do a better design" asks a designer for one (§6.3).

**What happens.** The words are passed as sent; "similar to the earlier ones" reaches the design engine as `revisionDirective`.

| Stage | What happens | The requester hears |
|---|---|---|
| Delivered within 7 days, opened for an automatic design | New round of the same request from its delivered task | "I'll redo *title* — the new version follows what you said, and the office checks it before it comes to you." |
| Waiting for the requester's changes (office sent it back) | Its round, as any change starts | Same |
| Being made, waiting for an answer | Kept on it for the office | "I'll redo *title* — it is still being made, so I've added what you said; …" |
| With the office, approved, being delivered, with a designer | Kept on it for the office | "I'll redo *title* — I've passed what you said to the office, so the new version follows it." |

The new round on a delivered design:

- Core reopens it in `projectLifecycleRequesterRevisionWithIntake` (`reopenDelivered`): delivered → designing, rev + 1, a new task whose parent is the delivered task.
- Only a request opened for an automatic design (its rev-1 projection says `autoGenerate`), delivered within 7 days, by words alone (no answer, photo, album or source).
- A design made by hand, or one too old, is refused (`WRONG_STAGE`) and the words are kept for the office instead.
- RequestLifecycle accepts the round only from a `chatinbox:revision:<update>` event whose Core receipt matches. It clears the finished delivery and approval of the round before, so the next approval delivers anew.
- The daily automatic-design allowance applies as to any change (`DAILY_CAP_REACHED` is told as before).
- Core gives the "I'll redo" line in its answer, and ChatInbox sends it in place of the usual "I'm making those changes now".

**The office path.** An office member's words reach intake when the office turn returns nothing. ADR-182's guard sends a member's change back to intake when they have designs of their own on the way. Redo words now go to intake too when the member has a design of their own on the way or delivered within 7 days, unless they reply to a draft or answer the bot's question about one. Without this, "try again" from the owner would have sent another requester's waiting draft back.

### 6.3 Titles

A request opened from words that name no design is never titled with them. These are redo or quality words ("make me a nice poster"), chat, and questions. It is named "New design request from *first name*" (KAAE: "KAAE: New design request from …"), and the words stay its instructions. Lines that do name a design keep it as their title: copy, a date, an event, a subject ("for the graduation"), a capitalised name ("Nawroz", "KAAE"). A later line that names the design is used before the first one.

The requester hears "your design" for a neutral name, in Core (`shortTitle`) and in RequestLifecycle's acknowledgement.

### 6.4 Cost

No new call. A redo of a delivered design starts one design round, the same as any requester change, within the daily automatic-design allowance. The intake router is asked only for `or-new` words, as for any unclear message, at ADR-144's cost (about $0.005). Its request grows by one clause per design and one sentence, about 40 tokens. The incident's words, a clear redo, ask no model.

### 6.5 Verification

- `apps/core/test/redo-understanding.test.ts`: 65 tests.
  - readings: 18 redo phrasings in English and Sorani, 4 redo-or-new, 13 that are not, and media;
  - plans: the incident with the owner as office member and requester, recency, two within minutes and the answer, redo or new and its answers, the router's pick, every stage, the 7-day window against the 3 days, a new-brief look-alike, a reply and a group;
  - wording in English and Sorani; the title rule; the router's request;
  - Core's reopen against the test database: started; refused for a design made by hand, one delivered 8 days ago, and a delivered one without redo words.
- `apps/core/test/natural-language-stress.test.ts`: 10 new scripts, S151–S160 (`fixtures/nl-scripts/redo.ts`):
  - S151, the exact incident;
  - S152, the owner while another requester's draft waits;
  - S153, a requester;
  - S154–S155, Sorani;
  - S156, two delivered a minute apart;
  - S157, "do a poster for the conference on the 5th" stays new;
  - S158, redo or new;
  - S159, in review;
  - S160, the title rule.
- `apps/worker/test/request-lifecycle-requester.test.ts`: two new tests (the reopen, and never for a design made by hand).
- Red first: with `apps/core/src`, `apps/worker/src` and `packages/integrations/src` at `53593d2c`, these fail:
  - 9 of the 10 scripts. S157, the new-brief look-alike, passes on the base, as it should;
  - 49 of the 65 unit tests. Most fail because the helpers do not exist; the 16 that pass are the "is not a redo" readings and the refusals;
  - the worker reopen test.
- Full runs: `apps/core`, `apps/worker` and `packages/integrations` together passed 332 files and 3,962 tests, with 3 files and 4 tests skipped. A Desk `vite build` was in place for CV-17. `pnpm typecheck` and `pnpm lint` pass.

### 6.6 Limits

- **Not tested live.** No live Telegram, no real model call, no native Sorani review (5 new lines in `SORANI_REVIEW.md`).
- **A redo with a photo** is read as before: a photo is new material, and the words around it are a change or a brief.
- **A request opened for a designer** (no design run) is never reopened automatically; the office redoes it from the kept words.
- **Recency.** "Delivered within 7 days" and "10 minutes apart" are judgement. Two designs delivered within 10 minutes of each other are always asked about.
