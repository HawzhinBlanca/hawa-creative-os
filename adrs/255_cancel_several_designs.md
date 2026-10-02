# ADR-255: A Requester Cancels Several Designs at Once

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/hunt3-cancel-many` (from production `48337099`); not deployed.
**Requirements:** FR-005 (requester messages), natural-language-only rule (owner, 2026-09-29).
**Changes a foundation:** no. No migration, no new dependency, no new paid call. Three new phrases.
**Builds on:**
- ADR-144: one planned action per requester message (`requester-turn.ts`).
- ADR-145: requester phrases in English and Sorani.
- ADR-230 and its addendum: a requester's cancel withdraws a request through its RequestLifecycle.
- ADR-251: a cancel that names nothing is asked about first.

**Number:** 255, assigned by the lead.

## 1. Context

The live canary chat (2026-10-02, about 07:34Z) had two designs with a designer, opened from one message: "Harvest Fair… (1/2)" and "Chess Club… (2/2)".

1. "please cancel both of them, we don't need them" got "Which design is this for? 1. … 2. … 3. A new design". `CANCEL_OBJECT` had no "both", so the words fell to the brief heuristics. A question about cancel words offered a new design.
2. The answer "both" got a status line about one design. `parseChoice` knew numbers, ordinals and names, not "both".
3. "and cancel the Chess Club flyer too" got "Do you want me to cancel Chess Club… (2/2)?". The trailing "too" broke `CANCEL_EN`, so a named cancel became cancel words the rules could not place, which ADR-230 always confirms.
4. Every title ended in "…". `requestTitle` added it even when nothing was cut.

A withdraw decision named one request. `RequestLifecycle.withdraw` checks that Core recorded that update's decision for that request.

## 2. Decision

1. **Cancel words can name several designs together.**
   - English: "both (of them)", "the two (of them)", "them both", "them all", "all of them", "each of them", "both posters", "all the designs". Sorani: "both", "both of them", "all of them".
   - The reading carries `every: 'both' | 'all'`.
   - "Both" means the chat's two open designs, or its two that can still be withdrawn. "All" means every open design.
   - If at least one of them can be withdrawn, the plan is `cancel-all`. It works the same in a reply to one design's message.
   - "Both" said in a chat with three designs is asked about, as before.
2. **One decision, one withdraw per request.**
   - Core records `lifecycleAction: 'withdraw'` with `requestId` (the first) and `requestIds` (all of them).
   - ChatInbox sends each id to its own RequestLifecycle, under the update's event id. Each object keys the event by its own request, so a replay records each once.
   - Core's projection accepts a request named in `requestIds`. A request the decision did not name is still refused.
   - A design approved or sent meanwhile is told too late, and its cancel is kept for the office, as ADR-230 does. When the decision names several requests, the kept cancel is stored under `<update>:<request>`, so each request has its own record.
3. **Uncertain words ask one question naming them all.** Cancel words the rules cannot place, such as "could you cancel both please", get one question: "Do you want me to cancel both X and Y?". With three or more designs, the question lists them. The intake router is not asked, because it picks one design.
   - "Yes" cancels all of them. "No" keeps them and gives their status. Naming one cancels only that one.
4. **"Both" and "all of them" answer "which design?".**
   - For a cancel, they cancel every design asked about. This includes a question asked before this change with the cancel words stored as `unclear`.
   - A change, a pause, or words for the office go to one design at a time. The requester is asked naturally which comes first, and told to send it again for the other.
5. **A cancel question never offers "A new design".** This holds even for a stored question that allowed it.
6. **"Too", "as well" and "also" never make a named cancel uncertain.** "And cancel the Chess Club flyer too" withdraws Chess Club. A cancel that names nothing ("and never mind", "also stop") is still asked about (ADR-251).
7. **"…" only where the name was cut.**
   - `requestTitle` adds "…" only when `cutText` cut the name.
   - `shortTitle` and `requesterTitleName` hide a stored "…" that follows a name shorter than the 45-character cut, and keep "(1/2)".
   - Office captions are unchanged.

## 3. Consequences

- A requester can withdraw several designs with one message. Each design's RequestLifecycle tells the requester and the office about its own design, so two designs mean two short notices.
- Changing several designs from one message is still not supported: one paid round and one late-change record per update. Such a request is asked about one design at a time.
- 44 assertions in 9 existing test files (30 tests) expected the decorative "…" and were changed. Only the ellipsis in their expected names changed. Their fixtures still store old titles with "…", so these tests now also cover the stored form.
- "The two" used to answer as option 2. It now means both.
- New phrases: `withdraw.askCancelBoth`, `withdraw.askCancelAll`, `routing.askOneAtATime` (English and Sorani). They are on the native-review list.

## 4. Verification

`apps/core/test/requester-cancel-several.test.ts` uses the live phrases. It covers unit tests on `readIntentByRules`, `planTurn`, `parseChoice`, `askText` and the titles, plus chat tests through Core's intake and the worker's `recordWithdraw` against the test database. It failed first (47 of 50) and passes now. `apps/worker/test/chat-inbox.test.ts` adds two tests: ChatInbox sends one withdraw per request, and the Core client validates `requestIds`.
