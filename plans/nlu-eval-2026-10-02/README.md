# Requester NLU evaluation set and rules baseline (2026-10-02)

This folder holds a labelled evaluation set for how Hawa understands requester messages, and the score of the current rule engine against it. It follows the 2026-10-02 review. That review found about 15 live NLU bugs in one day. It recommended reading intent with a model first, keeping a few hard guards as rules, and measuring the result against a labelled set instead of string-equality tests.

- Fixture: `apps/core/test/fixtures/nlu-eval/utterances.json` (302 cases)
- Scorer: `apps/core/test/nlu-eval.test.ts`
- Baseline report: `plans/nlu-eval-2026-10-02/BASELINE.json`. It is written here because `output/` is gitignored.

## How to run

```bash
npx vitest run apps/core/test/nlu-eval.test.ts
```

The test does not need a database and makes no model call. It rewrites `BASELINE.json` on every run. The output is deterministic (fixed clock, no timestamps), so the file changes only when the rules or the labels change. The test checks only that the fixture is well formed: unique ids, known intents, contexts, languages and sources, targets that exist in the context, and at least 180 cases. It passes whatever the accuracy is.

### What is scored

For each case the scorer runs the same pipeline Core's intake runs when the model reading is off:

1. `readIntentByRules`
2. `planTurn` against a small fixed chat for the case's context
3. ADR-250's `reconsiderNewBrief`

A chat with nothing on the way is planned with no requests. The plan is mapped back to the planner's vocabulary, as follows:

| Plan | Intent |
|---|---|
| `open` | `new_brief` |
| `revise`, `redo`, `note:change` | `change` |
| `note:cancel`, `cancel-all` | `cancel` |
| `tell` | `approval`, `deadline` or `delivery_request` |
| `reply:thanks` | `acknowledgement` |
| `reply:status` | `status` |
| `forward` with a question | `conversation` |
| "a change or a new design?", "redo or new?", or "Do you want me to cancel …?" after words that named nothing | `unclear` |
| "Which design?" about a certain intent | that intent |

A case counts as right when the intent acted on is its expected intent or one of its `alsoAccept` intents. `alsoAccept` is used in 16 cases, each explained in the case's note. Examples:

- A thumbs-up on a draft may be heard as thanks or as approval words.
- A lone unhappy emoji is either a refusal-only change or a conversation that the chat answer passes to the office.
- Asking first is acceptable for a cancel that names its design only by the verb.

The report also gives:

- the context-free accuracy of `readIntentByRules` alone
- per-language, per-context, per-source and per-intent precision, recall and F1
- a confusion matrix
- target accuracy: did the plan act on, or ask about, the right design?
- the costly errors: something was opened, withdrawn or approved when that was not meant
- every failure, and every case's outcome

### The contexts

| Context | Meaning |
|---|---|
| `none` | Nothing is on the way. |
| `designing` | Design A, "KAAE: Quality Assurance Workshop", is being made. |
| `in_review` | A's draft is with the office. |
| `awaiting_answer` | The office sent A back for changes. |
| `delivered` | A was delivered an hour ago. |
| `just_cancelled` | A design was just withdrawn. B, "KAAE: Teacher Appreciation Day", is still being made. |
| `two_open` | A is in review and B is being made. |

Six cases also carry `pendingAsk: change_or_new`. In those, the bot has just asked "Is this a change to …, or a new design?".

## The set

| | Cases |
|---|---|
| Total | 302 |
| English | 207 |
| Sorani | 89 (one is romanised Sorani) |
| Mixed | 6 |
| Live bugs | 60 |
| From existing repo fixtures | 140 (the NL stress scripts and the requester and classifier unit tests) |
| Synthetic | 102 |

Cases per expected intent:

| Intent | Cases |
|---|---|
| change | 81 |
| new_brief | 47 |
| conversation | 35 |
| cancel | 34 |
| acknowledgement | 21 |
| status | 21 |
| unclear | 15 |
| approval | 14 |
| deadline | 13 |
| delivery_request | 13 |
| hold | 8 |

The task asked for about 200 cases. The set came to 302 because every live finding in `HUNT2_FINDINGS.md` and `LIVE_TEST_2026-10-01.md` that a single message can represent is included, and so are its listed variants.

Labels say what a human office member would take the words to mean in that context. `unclear` means the right answer is to ask.

Undo-after-cancel words are labelled `conversation` with `undo: true`, because the planner has no undo intent: the conversation answer handles them (ADR-252).

**Sorani needs native review.** Sorani labels, and the synthetic Sorani phrasing (each note says "Needs native review"), must be checked by a native speaker before they are treated as ground truth. Where possible, the Sorani cases reuse phrasing that already exists in the repo's fixtures and tests. Each Sorani case's note gives its English meaning.

## Baseline (rules only, model reading off, 2026-10-02)

| Measure | Result |
|---|---|
| Overall | **281 / 302 = 93.0 %** |
| `readIntentByRules` alone, no context | 90.4 % |
| English | 92.8 % (192/207) |
| Sorani | 94.4 % (84/89) |
| Mixed | 83.3 % (5/6) |
| Target (right design) | 92.5 % (148/160) |

By source:

| Source | Accuracy |
|---|---|
| Repo fixtures | 98.6 % (138/140) |
| Live bugs | 95.0 % (57/60) |
| Synthetic | **84.3 % (86/102)** |

The gap between the repo fixtures and the synthetic cases is the main finding. The rules score close to 100 % on the phrases they were tuned on, and about 14 points lower on phrasing they have not seen.

Per intent:

| Intent | Precision | Recall |
|---|---|---|
| approval | 1.00 | 1.00 |
| delivery_request | 1.00 | 1.00 |
| new_brief | 0.96 | 0.98 |
| change | 0.99 | 0.91 |
| cancel | 0.97 | 0.94 |
| acknowledgement | 1.00 | 0.95 |
| status | 1.00 | 0.95 |
| deadline | 1.00 | 0.92 |
| hold | 1.00 | 0.75 |
| conversation | 0.83 | 1.00 |
| unclear | 0.47 | 0.60 |

There are three costly errors. Two opened a new request when a change was meant (`en-change-39`, `ckb-change-14`). One withdrew a design without asking (`en-cancel-29`).

### Top failure classes

1. **The change-or-new question is the catch-all for one design on the way (10 of 21 failures).** Words the rules cannot place get "Is this a change to …, or a new design?", even when a single design is in review and the words plainly edit it:
   - "take the phone number out"
   - "no KAAE in the headline please"
   - "hmm the font is hard to read"
   - "please cancel the gold border"
   - "stop using that font"

   Holds, deadlines and praise fall into the same question:
   - "don't continue with the design for now, we're waiting for the speaker list"
   - "no rush, next week is fine"
   - `ckb-hold-03`, `ckb-approve-05`

   So does a Sorani named cancel with a reason, which is the L17 shape (`ckb-cancel-10`). That question also offers "a new design" for cancel words.
2. **A correction that names the event opens a second request (L19 class, not fully closed by ADR-250).** In review, "the workshop is for university deans, not school principals" is read as a brief that carries event detail, and it opens a new request. `ckb-change-14` ("make another design, a better one", said on a draft) also opens a new request.
3. **Fragments fall to plain conversation.** In review, "no", "for the deans", "Nawroz", `ckb-unclear-01` and `ckb-unclear-02` are planned as conversation, so the chat answer greets the requester (friction 9). The labels say "ask what they mean". Arguably the planner has no such question besides change-or-new.
4. **Cancel and hold edges.**
   - "don't make it, we'll do it ourselves" is kept for the office as a change.
   - "forget about it" withdraws the design without asking. The rules treat "forget it" as naming the design. This set labels "forget about it" like "never mind", which is a judgement call.
5. **Brief and status phrasing outside the patterns.**
   - "Hey, we need something for the KAAE alumni meetup next month" is read as a greeting. This is an L15 variant listed in the findings.
   - "how's the workshop poster coming along?" goes to the office as a question instead of a status reply, because the status pattern allows one word after "the".

Most live bugs from 2026-10-01 and 2026-10-02 now pass on this branch (57 of 60). The three still failing are `en-brief-19`, `en-unclear-01` and `ckb-cancel-10`.

### What this set cannot see

- **The answer layer**, for example the greeting text sent for a `conversation` plan. That is where friction 9 and 11 live.
- **The office turn**, for a member who is also the requester (L18, L20, R8).
- **Edited messages, photos, albums and groups.**
- **`parseChoice` beyond the six change-or-new answers.**
- **The intake model fallback.** No model was called.

## What a model-first reader has to beat

Run the same cases through the model-first reader, with the hard guards below applied after it, and compare `outcomes` case by case with this baseline. To replace the rules it should:

- beat **93.0 % overall** and **84.3 % on synthetic cases** (the held-out signal)
- not fall below the rules on any intent's recall (currently hold has the lowest recall)
- have **zero costly errors**: nothing opened, withdrawn or approved unless that was meant
- score at least the baseline on Sorani, once a native speaker has reviewed the Sorani cases

These hard guards must stay rules, outside the model, whatever it reads:

1. **Cancel and withdraw confirmation.**
   - A cancel that names nothing ("never mind", "stop", "no need") is asked about first.
   - Only withdrawable requests are ever offered or withdrawn.
   - Cancel words never offer "a new design".
   - Undo words are never applied to another open design.
2. **Approval needs the office role.** A requester's approval words only tell the office (ADR-022). Refusals ("not approved", "don't send it") are checked before approval words. A delivery request ("send it again") is never approval.
3. **A paid round needs certainty.** A round starts only for a design that waits for the requester's changes, known by a reply, as the only candidate, by its name, or by a model reading with confidence of 0.85 or more. It never starts by recency alone. Changes to a design that is being made or is in review are kept for the office.
4. **Copy is never invented.** A brief's exact copy comes only from the requester's own words.
