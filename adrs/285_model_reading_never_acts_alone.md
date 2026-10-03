# ADR-285: A Model Reading Never Acts on a Design by Itself

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/nlu-model-first` (from `claude/hunt3-fixes` 87f1a981). Not deployed. The owner approved acting on the recommendation of `plans/nlu-eval-2026-10-02/MODEL_FIRST_RESULTS.md`.
**Requirements:**
- FR-004: one logical decision per message.
- FR-005: requester messages.
- The README hard guard 3 of `plans/nlu-eval-2026-10-02`: a paid round needs certainty.

**Changes a foundation:** no. There is no migration, no new dependency and no new paid call. The planner gains one guard.
**Supersedes:** the path of ADR-144 §2.3/§2.4 and the ADR-200 addendum by which a model reading at confidence 0.85 or more starts a paid round. That path covered a revision round of a design waiting for changes, and a redo of the latest design. The README's hard guard 3 named the same path ("…or by a model reading with confidence of 0.85 or more").
**Builds on:**
- ADR-144: the intake router.
- ADR-200: redo words.
- ADR-250: cancel words through the router.
- ADR-272: rules after the NLU evaluation.

**Number:** 285. Checked free on 2026-10-03 across every branch on origin, the main checkout and every worktree under `.claude/worktrees`. The highest number found was 284.

## 1. Context

The model-first experiment of 2026-10-03 (`scripts/experiments/nlu-model-first.ts`) ran the 356 labelled requester messages through the intake router exactly as production asks it. It used the real `createRequesterIntentModel` and `readOnce`, with Sol. The router is asked only about words the rules could not place. On this set it was asked 15 times. Its "change" readings were right once and wrong five times.

The wrong readings were fragments that a person would ask about:

- "for the deans"
- "for the parents"
- "for the alumni"
- "Quality Assurance Workshop, 22 October"
- "never mind about it"

Each was kept as a change for the office.

One reading started a paid redo of a delivered design. That was "do a better design for the conference", read at confidence 0.94. The rules deliberately ask "redo it, or a new design?" there, because "the conference" is not the delivered workshop.

With the router, intake scored 344 of 356. Without it, intake scored 349. Two independent samples gave the same answers.

## 2. Decision

`planTurn` applies one guard, `withoutModelAction`, to every plan made from a reading whose source is a model. If the plan would start a paid round (`revise`, `redo`), or keep a change on a design for the office (`note` of a change), it becomes the rules' own question about the design the model named:

- "Is this a change to …, or a new design?"
- "Redo it, or a new design?" for redo words.
- With cancel words, the question offers no new design, as ADR-255 and ADR-272 require.

This holds whatever the model's confidence is. The requester's answer then acts, as every answer does. A plan that answers the bot's own question (`resolves`) is the requester's choice, so the guard leaves it alone.

What the router may still do is unchanged:

- It may name which design a question is about.
- It may say "new design" at 0.8, which opens a request as before.
- It may say "chatter" at 0.8, which gets the conversation answer.
- For cancel words, it may only name the design (ADR-250).

Approval and withdrawal were never the router's to decide.

**Fragments (owner's item 2).** On this set the router's change readings were wrong in five of six cases. The one it got right ("the logo looks squashed") was asked about before the router existed, and asking about it is harmless. Keeping fragments as changes on the model's word is therefore net harmful. They are asked instead, in the same guard.

**Hard guard 3, restated:** a round starts only for a design that waits for the requester's changes, and only when that design is known:

- by a reply;
- as the only candidate the rules found;
- by its name in the words;
- by the requester's answer to the bot's question.

It never starts by recency or by a model reading.

## 3. Evidence

Measured from the cached answers. There were no new paid calls. Both samples gave the same result.

| Production intake path (356 cases) | Before (router as deployed) | After ADR-285 | Rules only |
|---|---|---|---|
| Overall | 344 | **349** | 349 |
| Held out (54) | 47 | 49 | 49 |
| Sorani (89) | 88 | 88 | 88 |
| Costly errors (opened, withdrawn, approval told) | 0 | **0** | 0 |
| Paid rounds started wrongly | 1 (`en-unclear-05`) | **0** | 0 |
| Recall of `unclear` | 59.1 % | 86.4 % | 86.4 % |

After the guard, the router changes the plan in two cases:

- `en-brief-29`: it opens a brief that the rules asked about. Both plans are accepted.
- `ho3-ack-01`: it answers praise as conversation instead of asking. Both are wrong.

Tests:

- `apps/core/test/requester-intent-routing.test.ts`: the router's pick never starts a round by itself; a sure redo is asked about; a fragment is asked about. All go through intake.
- In the same file, under "ADR-285: whatever the router's confidence…": the real `createRequesterIntentModel` with a fixture completion, then `planTurn`.
- Each new test fails with the guard removed.

## 4. Consequences

- **A slower requester.** A requester whose words only the model could place answers one more question before a paid round. Measured on the labelled set, that is the price of never paying for a misreading.
- **Fewer router calls would do.** The router's paid call is now useful only for naming a design among several, opening a new brief, or answering chatter. Narrowing when it is called, or switching it off, is left to a later decision measured with the same script.
- **The office reader is untouched.** The office turn's own reader (ADR-200, `office-telegram-turn.ts`) and the copy reader (ADR-232) are not affected.
