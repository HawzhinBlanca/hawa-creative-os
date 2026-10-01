# ADR-200: The Office Chat Is Read Like a Chat

**Date:** 2026-10-01
**Status:** Implemented and tested on branch `claude/office-chat-understanding` (from production `1ba5bda9`); not deployed.
**Requirements:** FR-043 (only the office approves or rejects a design), FR-062 (paid model calls are limited by office and client scope), NFR-016 (an office operator does routine work without a command line).
**Changes a foundation:** no. It extends ADR-144's intake-router ledger with a second reader (migration 074) and adds no dependency.
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

### 2.5 One call per update, in the shared allowance (migration 074)

The office reading uses ADR-144's ledger and allowance through one shared function (`readOnce` in `requester-intent-model.ts`; the provider call stays in the one file the egress lint allows).

- `hawa.requester_intent_calls` gains `reader` (`requester` | `office`). `client_id` may be null for an office reading only, because it concerns drafts of several clients. Uniqueness moves to (tenant, reader, update).
- An office reading is charged to the office and the `intake_router` role, never to one client's allowance. A replay uses the stored decision and never calls again.
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
  - the real reader against migration 074: one call per update, charged to no client and counted under `intake_router`, a requester row beside it, a provider 500 → rules end to end, a refused allowance → no call and rules end to end, no consent or a mock key → no call;
  - a cost bound.
- Red first: with `office-telegram-turn.ts` and the office catalogue reverted to `1ba5bda9` (stubs for the three new helpers so the file loads), 42 of 126 fail. The own-design guard test was added after this run; it passes on the base, which asks no model, and fails here with the guard removed:
  - 13 of the 15 conversation tests. The owner's own "send it" and the brief/chat case pass on the base, as they should;
  - the end-to-end real-reader test;
  - 28 units: 13 references, the ordinal, the 13 plain yeses and the flag.
- `apps/core/test/natural-language-stress.test.ts`: 14 new office scripts (S137–S150, `fixtures/nl-scripts/office-chat.ts`), with a fixture office reading in the harness. S123–S125 now expect the confirmation. In the harness a private chat's id is now its person's id, as in Telegram.
- `apps/core`, `apps/worker`, `packages/integrations` and `packages/db/test/schema-upgrade.test.ts` together: 332 files and 3,878 tests passed, with 3 files and 4 tests skipped. That run had a Desk `vite build` in place, which CV-17's bundle-size test reads. `pnpm typecheck` (653 test roots) and `pnpm lint` pass.

## 5. Limits and open points

- **Migration number.** Codex's branch `codex/research-grade-design-system` uses 074–077 and the runner refuses gaps, so 074 here must be renumbered after them at integration. `startup-schema-check` and `schema-upgrade` tests name it.
- **Owner wording left as it was.** Two office lines still name a reply target: the draft alert's last line (`office.draftAlertDecide`, ADR-180) and `office.lostTrack` (ADR-040 addendum). Both were the owner's own wording, and the turn no longer needs a reply. Changing them is for the owner.
- **Not tested.** No live Telegram, no real model call, no native Sorani review.
- **Requester names.** Not known for group requests, or for requesters who have not written since this is deployed. Those drafts are "the requester", as before.
- **Shared allowance.** Office readings share the `intake_router` role allowance with requester routing. A busy office day counts against both.
