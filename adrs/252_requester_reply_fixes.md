# ADR-252: Requester Replies After a Draft, a Cancel, an Emoji or an Edit

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/hunt2-messages` (from production `1e0616f0`); not deployed.
**Requirements:** FR-005 (requester messages), FR-055 (failures become regression checks).
**Changes a foundation:** no. No migration, no new dependency, no new paid call.
**Builds on:**
- ADR-144: requester intent routing.
- ADR-145: natural media and requester wording.
- ADR-230: a requester's cancel withdraws a request.
- ADR-231: truthful chat replies.

**Number:** 252, assigned by the lead.

## 1. Context

Bug hunt 2 (2026-10-02, `HUNT2_FINDINGS.md`) found requester replies that broke the owner's natural-language-only rule. This ADR covers friction items 5, 7, 8, 9, 11 (the edit fallback only), 12 and 13:

- **Item 5.** Two requests in one message were split only after a bare "make", "we need" or "I need" at the very start. "Can you make a poster for X … and a flyer for Y", "Hi, we need …" and ", and also a flyer …" each became one request with mixed copy.
- **Item 7.** Just after a cancel, "undo that", "bring it back" and "actually continue" got the new-design greeting.
- **Item 8.** "👎", "😡" and "❌" were answered "🙏 Thank you.", because every pictograph counted as thanks.
- **Item 9.** After a draft, "no", "hmm" and "continue" got the new-design greeting.
- **Item 11.** An edit's "your design" stayed in English inside a Sorani answer.
- **Item 12.** The bot told requesters "Just say “change” or “new”", "Just say “yes”" and "Answer with the number or the name".
- **Item 13.** Two problems with edited messages:
  - An edited approval was kept as a change, which held Deliver until the office read it.
  - An edit to a delivered design's words was answered "so it's used". This was untrue.

## 2. Decision

### 2.1 Two requests in one message (`packages/domain/src/request-deliverables.ts`)

- **Greeting and polite opener.** A leading greeting is set aside before the request is read: "Hi", "Hello!", "Good morning", "Dear team", "سڵاو". So is a polite opener: "can/could/would you (please)", "we would like (you) to", "I need you to". The greeting stays in `shared`.
- **Separators.** ", and also" and "; also" separate deliverables, as "and" already did.
- **Earlier designs.** A later piece that starts with "the <format>" and names no subject ("…, the flyer we sent last week had the wrong date") refers to an earlier design. The message stays a single request.
- **Unchanged semantics.**
  - Formats sharing one subject ("a poster and a story version of it") are still several formats of one design.
  - "And" that joins details ("with the logo and the date") still leaves one request.

### 2.2 Unhappy emoji (`telegram-classifier.ts`)

- `isNegativeReaction` covers messages that are emoji alone, with at least one unhappy emoji (👎 😡 ❌ 😞 😢 …). `isAcknowledgement` no longer counts these as thanks.
- The heuristics read them as `other` with a reason of their own. They are never `feedback`. A "👎" that replies to a design waiting for changes would otherwise start a paid round with "👎" as its directive.
- In the chat answer (2.3):
  - **The requester** hears that the office was told and is asked what to change.
  - **The office** gets an alert that names the latest design.
  - **Nothing is changed or held.**
- `plainClientAnswer` does not take an unhappy emoji as an organisation name.

### 2.3 Context before the greeting (`lifecycle-chat-answers.ts`)

Words the heuristics read as `other` are checked against the chat's context before the greeting is used. This excludes thanks. The context is `activeChatRequests` plus the latest request withdrawn in the last 30 minutes. The checks run in order:

1. **Words that take back a recent withdrawal (`undoesWithdrawal`).**
   - Words that name the cancel ("I cancelled by mistake", "don't cancel it", "uncancel") always count.
   - Short words ("undo that", "bring it back", "actually continue", "carry on", "بەردەوام بە") count only when no open design moved after the withdrawal.
   - **The requester** is told the truth: the request had already been stopped, the bot cannot restart it, and they can send the request again. If an office chat exists, they also hear that the office was told.
   - **The office** gets an alert that nothing was restarted and no other design was changed.
   - **Nothing is applied to any other design.** A withdrawn request has no reopen path, so nothing promises it back.
2. **An unhappy emoji** (2.2).
3. **Any other words, when the chat has an open or recently delivered design.** The answer is `statusText` for the latest design, followed by "If you'd like anything changed, just tell me what." The greeting is never used here.
4. **A chat with nothing going on.** It is greeted, as before.

An office alert decided with an answer is now recorded with it. A replay after a lost first answer still carries the alert.

"I like it", "we like it", "I love it", "lovely" and "beautiful" are acknowledgements. Under a draft they are answered with thanks.

### 2.4 Edited messages (`lifecycle-edit-intake.ts`)

- **Edited approval, timing or file words.** These are edits of a message whose plan was `tell`. They are read again as a new message. They are no longer kept as a change, so Deliver is not held by them.
- **Edits to a delivered design's words.** The answer is `editPassedDelivered`: the design was already sent with the old wording, the new wording went to the office, and the office will follow up.
- **Designs with no name of their own.** The design is named with `LIFECYCLE_MESSAGES.yourDesign` in the requester's language.

### 2.5 No words to type (`routing.ts`, `sources.ts`)

- **Questions.** `askChangeOrNew`, `askCancel`, `askIsThisOne` and `askWhichDesign` ask their question and nothing more, in both catalogues.
- **Confirming text.** The voice and PDF confirmations end "If not, send me the corrected text."
- **Test.** The catalogue test now forbids "just say", "answer with the number" and their Sorani forms in every requester phrase.
- **Office phrases.** These are unchanged.

## 3. Left to the requester-turn owner (ADR-251)

"sorry I cancelled by mistake, please continue" names a mistake, so `readIntentByRules` reads it as a change. The change is kept on another open design before this answer is asked. The fix is one rule in `requester-turn.ts`, placed before the refusal and change rules:

```ts
if (asksToUndoCancel(core)) return rules('conversation', 'Takes back a cancel');
```

`asksToUndoCancel` comes from `telegram-classifier.ts`. With that rule, `planTurn` answers `conversation`, and 2.3 answers the words. `apps/core/test/requester-reply-fixes.test.ts` holds this case as `it.fails`. Once the rule lands, that test must become a plain `it`.

## 4. Evidence

- **New tests.**
  - `apps/core/test/requester-reply-fixes.test.ts`: 39 pass and 1 expected fail.
  - `packages/domain/test/request-deliverables.test.ts`: 13 new cases, 33 in total.
- **Before the fix.** The new tests fail when run against the pre-change service files.
- **Updated tests.** Five existing tests encoded the instruction wording, and their expectations were updated: requester-intent-routing (2), truthful-chat-replies, lifecycle-voice and lifecycle-source.
- **Full suite.** 7033 tests pass, 1 is an expected fail and 67 are skipped.
- **Sorani review.** The new and changed Sorani lines are added to `SORANI_REVIEW.md` and need native review.
