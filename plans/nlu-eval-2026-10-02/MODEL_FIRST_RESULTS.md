# Model-first reading of requester messages: results (2026-10-03)

**Question.** Does a model-first reading of requester messages, with the hard rule guards after it, beat the rules?

**Answer: no. Keep the rules.** The model-first reader fixes the hardest held-out phrasing: 16 of 18 round-3 cases right, against 14 for the rules. But it fails three of the four gates in the README's "What a model-first reader has to beat":

- It falls below the rules' recall on six intents.
- It makes costly errors. It opens a request for a standing rule said in an empty chat, and it starts a paid redo round that was not meant.
- It is one or two cases below the rules on Sorani.

The hybrid (model only where the rules are unsure) also scores below rules-only. So does the intake router that production already has.

Spend: **US$2.24** of the US$6 cap, over 1,454 paid calls. This is the production ledger's own estimate, which prices Sol input at $4.50 per million tokens. At pricing.json's $2 list rate it is about $1.25. Reruns are free from the cache.

## What was run

Script: `scripts/experiments/nlu-model-first.ts`. All 356 cases of `apps/core/test/fixtures/nlu-eval/utterances.json` (302 original, 54 held out) go through each arm. The script uses the same fixed chats, clock and scoring as `apps/core/test/nlu-eval.test.ts`.

| Arm | What it is |
|---|---|
| **rules** | `readIntentByRules` → `planTurn` → `reconsiderNewBrief`, with no model. The script stops unless this arm reproduces `BASELINE.json` case by case. It does, on all 356 cases, so the scoring is the harness's own. |
| **production** | The rules, then the intake router exactly as `lifecycle-internal.routes.ts` asks it today (ADR-144/200/250/255). The router is asked only when the plan is a question about unclear or cancel words, and only about that question's candidates. It runs through the real `createRequesterIntentModel` and `readOnce`: same body, same `resolveModel('text')` under the production tier (`gpt-6.1-sol`, `reasoning_effort: low`), same reservation, parse, thresholds and merge. Only the ledger is an in-memory stand-in: no database is touched, the client is taken to have consented to OpenAI, and the allowance always admits. The message is read at the fixture's clock, so "last changed 5 minutes ago" is what the model sees. |
| **variant** | Model first. One call per message with the planner's whole vocabulary (11 intents, design number, every/both, question, confidence). The hard guards are applied as rules after it (below), then `planTurn` and `reconsiderNewBrief`. Run on Sol, the production text model, and on `gpt-4.1-mini`, the cheapest admitted model and the dev tier's text model. |
| **hybrid** | The rules first. The variant's guarded reading is used only where the rules are unsure: their plan is a question, or their reading is `unclear` or `conversation`. This is 77 of the 356 messages (21.6 %). |

Guards after the variant's reading, as the README requires:

1. **Cancel.** A model `cancel` that the rules do not also read is only asked about ("Do you want me to cancel …?"). The question goes among withdrawable designs, never offers a new design, and nothing is withdrawn. A cancel the rules do read keeps their flags, so a bare cancel is still asked first. Undo words keep the rules' reading.
2. **Approval.** Approval is only ever told to the office, by the planner. Refusal words, and a delivery request the rules read, win over a model `approval` or `acknowledgement`.
3. **Paid round.** The planner's rule applies: a model's pick starts a round only at confidence 0.85 or more.
4. **New request.** A model `new_brief` opens a request only when the rules also read a brief, or when nothing is on the way (then instruction-only, for a person). Otherwise the requester is asked "a change, or a new design?". Copy never comes from the model.

A reading below 0.5 confidence falls back to the rules.

Every arm with a model was run twice, as two independent samples (`cache.json` and `cache-sample2.json`), to measure how stable the answers are.

## Numbers

Model arms show sample 1, with sample 2 in brackets where it differs. "Costly" uses the harness's definition: something opened, a cancel, or approval words heard, when none was meant. "Wrong paid round" is a revision or redo round that was not meant. The harness does not count it as costly, but it is paid.

| Measure | rules | production (router) | variant, Sol | hybrid, Sol | variant, mini | hybrid, mini |
|---|---|---|---|---|---|---|
| Overall (356) | **349 (98.0 %)** | 344 (96.6 %) | 337 (94.7 %) [335] | 343 (96.3 %) [342] | 315 (88.5 %) [311] | 343 (96.3 %) [342] |
| Original set (302; rules tuned on it) | **300** | 297 | 286 [284] | 293 [292] | 264 [261] | 291 |
| Synthetic, original (102) | **101** | 99 | 100 [99] | 100 [99] | 91 [90] | 99 |
| Held out (54, English) | 49 | 47 | 51 | 50 | 51 [50] | **52** [51] |
| Held out round 3 (18, never tuned on) | 14 | 13 | 16 | 15 | **17** [16] | **17** [16] |
| English (261) | **255** | 250 | 244 [243] | 249 | 235 | 249 |
| **Sorani (89)** | **88** | **88** | 87 [86] | **88** [87] | 75 [71] | **88** [87] |
| Mixed (6) | 6 | 6 | 6 | 6 | 5 | 6 |
| Target: right design (191) | 188 | 189 | 188 | **190** | 170 [167] | **190** |
| Costly errors (harness) | **0** | **0** | 2 [3] | 2 [3] | 1 [2] | **0** [1] |
| Wrong paid rounds | **0** | 1 | 1 | 1 | 1 | 1 |
| Messages that call a model | 0 % | 4.2 % | 100 % | 21.6 % | 100 % | 21.6 % |
| Cost per message (ledger rates) | $0 | $0.000067 | $0.0028 | $0.00062 | $0.00026 | $0.000056 |
| Cost per model call | — | $0.0016 | $0.0028 | $0.0029 | $0.00026 | $0.00026 |
| Model latency p50 / p95 (per call) | — | 2.15 / 3.43 s | 2.14 / 4.02 s [2.04 / 2.99] | 2.39 / 4.36 s | 0.71 / 0.88 s | 0.70 / 0.90 s |

Tokens per call:

- Router: 276 in, about 30 out.
- Variant: about 550 in, 35 out on Sol, 23 out on mini.

Every call answered (HTTP 200, schema-valid). None was truncated by the router's 400-token limit.

### Recall per intent (%, sample 1)

| Intent (cases) | rules | production | variant Sol | hybrid Sol | variant mini | hybrid mini |
|---|---|---|---|---|---|---|
| new_brief (56) | 100 | 100 | 98.2 | 100 | 98.2 | 100 |
| change (103) | 98.1 | 99.0 | 96.1 | 98.1 | 94.2 | 98.1 |
| cancel (36) | 100 | 100 | 97.2 | 100 | 69.4 | 100 |
| hold (12) | 91.7 | 91.7 | **100** | 91.7 | 75.0 | 91.7 |
| approval (14) | 100 | 100 | 100 | 100 | 85.7 | 100 |
| acknowledgement (24) | 95.8 | 95.8 | **100** | **100** | **100** | **100** |
| status (25) | 100 | 100 | 96.0 | 100 | 80.0 | 100 |
| deadline (16) | 100 | 100 | 100 | 100 | 93.8 | 100 |
| delivery_request (13) | 100 | 100 | 100 | 100 | 100 | 100 |
| conversation (35) | 100 | 100 | 88.6 | 94.3 | 91.4 | 97.1 |
| unclear (22) | **86.4** | 59.1 | 63.6 | 63.6 | 59.1 | 59.1 |

### Stability (two samples of the same requests)

| Arm | Decisions that changed | Outcomes that changed |
|---|---|---|
| production router, Sol | 0 of 15 | 0 |
| variant, Sol | 2 of 356 | 2 |
| variant, mini | 12 of 356 | 6 |
| hybrid, Sol | 1 of 77 | 1 |
| hybrid, mini | 6 of 77 | 3 |

Sol is nearly deterministic at `reasoning_effort: low`. Mini is not: its costly-error count moves between 0 and 1 from one sample to the next.

## Against the README's gates

| Gate | Variant, Sol | Hybrid, Sol | Hybrid, mini | Production router |
|---|---|---|---|---|
| Beats round 3 (rules: 14/18) | yes, 16 | yes, 15 | yes, 17 [16] | no, 13 |
| No intent's recall below the rules | **no** (6 intents below; unclear 63.6 vs 86.4) | **no** (conversation, unclear) | **no** (conversation, unclear) | **no** (unclear) |
| Zero costly errors | **no** (2–3, plus a paid redo) | **no** (2–3, plus a paid redo) | **no** (0–1, plus a paid redo) | costly 0, but a paid redo |
| Sorani at least the rules (88/89) | **no** (87, 86) | yes, 88 [87] | yes, 88 [87] | yes, 88 |

The round-3 gain is two or three cases out of 18. It is real in both samples, but too small to outweigh what is lost.

## Costly errors and paid rounds, case by case

| Case | Context | Words | Arms | What happened |
|---|---|---|---|---|
| `en-chat-13` | none | "From now on, always put the logo bottom-right" | variant Sol and hybrid Sol, both samples | The model read a standing rule as a new brief (confidence 0.80–0.84). With nothing on the way, guard 4 lets it open: **a request is opened** (instruction-only, for a person). The rules answer it as conversation. |
| `ckb-chat-07` | none | Sorani: "From now on always put the logo at the bottom right" | variant Sol and hybrid Sol, sample 2 | The same, in Sorani: **a request is opened**. |
| `en-unclear-05` | delivered | "do a better design for the conference" | **production router**, and every model arm | The rules read redo-or-new and ask. The model says "change" to the delivered design at 0.88–0.94 (the router: 0.94), and that is above 0.85. So the router **starts a paid redo round** of the Quality Assurance Workshop poster for "the conference". The ADR-200 addendum allows this, and production does it today. |
| `ho3-cancel-01` | designing | "never mind about it" | variant and hybrid, Sol and mini | The model read a cancel. Guard 1 turns it into "Do you want me to cancel …?", so **nothing is withdrawn**. The harness counts the question as a cancel because the reading is not flagged as a bare cancel. The plan is the same as for a bare cancel. |
| `ckb-hold-01` | designing | Sorani: "Hold it / stop it" | variant mini, sample 1 | Read as approval. **The office is told the requester approved** a design that is still being made. |
| `en-change-49` | in_review | "don't send it" | variant mini, sample 2 | Read as a cancel. Guard 1 makes it a question; nothing is withdrawn. |

Guards 1 and 2 held everywhere: no model reading withdrew a design or approved anything unasked. Guard 4 allowed the two opens, because nothing was on the way. Guard 3 allowed the paid redo, because the model was confident.

## Sorani (89 cases)

Sorani is reported separately and is still pending native review (README). Descriptions below are the cases' English meanings.

- **rules:** 88/89. Misses `ckb-unclear-01` (Sorani "No" on a draft), which is read as conversation.
- **production router:** 88/89. It is asked about one Sorani case (Sorani "Nawroz" alone), answers "unsure", and the question stands.
- **variant, Sol:** 87/89 (86 in sample 2). It reads "don't send it" (refusal only, `ckb-change-19`) and a bare "stop" (`ckb-cancel-12`) as a hold. In sample 2 it also opens a request for the standing rule (`ckb-chat-07`).
- **hybrid, Sol:** 88/89 (87). "Stop" is read as a hold.
- **variant, mini:** 75/89 (71). Sorani cancels are read as hold or change: "cancel it", "no, cancel it", "cancel both of them", "cancel all of them", and the live L17 named cancel. "Hold it" is read as approval. A full Sorani brief is read as conversation, and "we are in a big hurry" as thanks. Mini is not fit to read Sorani alone.
- **hybrid, mini:** 88/89 (87). Misses Sorani "Nawroz" alone, which is read as conversation.

## Where the production router stands

On this set, the intake router that production already has is a net loss. It fixes 1 case and breaks 6:

- **Fixed:** "the logo looks squashed" becomes a change note.
- **Broken:** fragments that the label says to ask about become change notes kept for the office: "for the deans", "for the parents", "for the alumni", "Quality Assurance Workshop, 22 October". "Never mind about it" also becomes a change note. "Do a better design for the conference" becomes a **paid redo** of the delivered design.

The harness's rules-only baseline (349) does not include the router. So whenever a client has consented to OpenAI egress, live intake scores 344 on this set, not 349.

Whether KAAE's consent is on in production was not checked, because no SQL was run on production.

No trivial bug was found in the router path. Every outcome follows its prompt and the ADR-144/200/250 thresholds. No production code was changed.

## Case-by-case diff against the rules

Sorani cases are given by their English meaning.

### Production router vs rules (fixed 1, broken 6, both wrong 6)

| | Case | Context | Words | Expected | Rules | Production |
|---|---|---|---|---|---|---|
| fixed | `ho3-change-02` (held out) | in_review | "the logo looks squashed" | change | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `en-unclear-02` | in_review | "Quality Assurance Workshop, 22 October" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `en-unclear-03` | in_review | "for the deans" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `en-unclear-05` | delivered | "do a better design for the conference" | unclear | unclear (ask:unclear+new -> A) | change (**redo -> A**, paid) |
| broken | `ho-unclear-01` (held out) | in_review | "for the parents" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `ho3-cancel-01` (held out) | designing | "never mind about it" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `ho3-unclear-01` (held out) | in_review | "for the alumni" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| both wrong | `en-unclear-01` | in_review | "no" | unclear | conversation | conversation |
| both wrong | `ckb-unclear-01` | in_review | Sorani: "No" | unclear | conversation | conversation |
| both wrong | `ho-unclear-03` (held out) | in_review | "nope" | unclear | conversation | conversation |
| both wrong | `ho3-change-01` (held out) | in_review | "can we lose the subtitle?" | change | conversation (forward:question) | conversation (forward:question) |
| both wrong | `ho3-hold-01` (held out) | designing | "drop it for now, we'll come back to it next month" | hold | change (note:change -> A) | change (note:change -> A) |
| both wrong | `ho3-ack-01` (held out) | in_review | "fantastic, my boss is really happy with it" | acknowledgement or approval | unclear (ask:unclear+new -> A) | conversation |

### Variant (model first), Sol, vs rules (fixed 7, broken 19, both wrong 0)

| | Case | Context | Words | Expected | Rules | Variant |
|---|---|---|---|---|---|---|
| fixed | `en-unclear-01` | in_review | "no" | unclear | conversation | unclear (ask:unclear+new -> A) |
| fixed | `ckb-unclear-01` | in_review | Sorani: "No" | unclear | conversation | unclear (ask:unclear+new -> A) |
| fixed | `ho-unclear-03` (held out) | in_review | "nope" | unclear | conversation | unclear (ask:unclear+new -> A) |
| fixed | `ho3-change-01` (held out) | in_review | "can we lose the subtitle?" | change | conversation (forward:question) | change (note:change -> A) |
| fixed | `ho3-change-02` (held out) | in_review | "the logo looks squashed" | change | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| fixed | `ho3-hold-01` (held out) | designing | "drop it for now, we'll come back to it next month" | hold | change (note:change -> A) | hold (note:hold -> A) |
| fixed | `ho3-ack-01` (held out) | in_review | "fantastic, my boss is really happy with it" | acknowledgement or approval | unclear (ask:unclear+new -> A) | acknowledgement (reply:thanks) |
| broken | `en-brief-15` | in_review | "This one is for ZAR Podcast, not KAAE: poster for the ZAR Podcast season launch, …" | new_brief | new_brief (open) | change (note:change -> A) |
| broken | `en-change-49` | in_review | "don't send it" | change | change (note:change -> A) | hold (note:hold -> A) |
| broken | `en-cancel-10` | designing | "cancel the last request" | cancel | cancel (note:cancel -> A) | unclear (ask:unclear -> A) |
| broken | `en-cancel-27` | designing | "stop" | unclear | unclear (ask:cancel -> A) | hold (note:hold -> A) |
| broken | `en-hold-06` | designing | "wait" | conversation or acknowledgement | acknowledgement (reply:thanks) | hold (note:hold -> A) |
| broken | `en-hold-07` | designing | "hold on" | conversation or acknowledgement | acknowledgement (reply:thanks) | hold (note:hold -> A) |
| broken | `en-neg-02` | in_review | an angry-face emoji | change or conversation | conversation | unclear (ask:unclear+new -> A) |
| broken | `en-neg-03` | in_review | a cross-mark emoji | change or conversation | conversation | unclear (ask:unclear+new -> A) |
| broken | `en-status-05` | designing | "hello??" | status | status (reply:status) | conversation |
| broken | `en-chat-13` | none | "From now on, always put the logo bottom-right" | conversation | conversation | new_brief (**open**) |
| broken | `en-chat-14` | in_review | "hmm" | conversation | conversation | unclear (ask:unclear+new -> A) |
| broken | `en-unclear-02` | in_review | "Quality Assurance Workshop, 22 October" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `en-unclear-03` | in_review | "for the deans" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `en-unclear-05` | delivered | "do a better design for the conference" | unclear | unclear (ask:unclear+new -> A) | change (**redo -> A**, paid) |
| broken | `ckb-change-19` | in_review | Sorani: "Don't send it" (refusal only) | change | change (note:change -> A) | hold (note:hold -> A) |
| broken | `ckb-cancel-12` | designing | Sorani: "Stop" (bare) | unclear | unclear (ask:cancel -> A) | hold (note:hold -> A) |
| broken | `ho-unclear-01` (held out) | in_review | "for the parents" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |
| broken | `ho3-cancel-01` (held out) | designing | "never mind about it" | unclear | unclear (ask:unclear+new -> A) | cancel (ask:cancel -> A; asks first) |
| broken | `ho3-unclear-01` (held out) | in_review | "for the alumni" | unclear | unclear (ask:unclear+new -> A) | change (note:change -> A) |

Sample 2 differs in two cases, and both break:

- `ckb-chat-07`: the Sorani standing rule is read as a new brief and opened.
- `en-status-04`: a status question is asked "a change, or a new design?".

### Hybrid, Sol, vs rules (fixed 6, broken 12, both wrong 1)

- **Fixed** (the variant's fixes, except "drop it for now", where the rules were sure and the model was not asked): "no", Sorani "No", "nope", "can we lose the subtitle?", "the logo looks squashed", "fantastic, my boss is really happy with it".
- **Broken:**
  - "stop", Sorani "Stop": read as hold.
  - The angry-face and cross-mark emoji, "hmm": asked "a change, or a new design?".
  - "From now on, always put the logo bottom-right": opened.
  - "Quality Assurance Workshop, 22 October", "for the deans", "for the parents", "for the alumni": read as change notes.
  - "do a better design for the conference": paid redo.
  - "never mind about it": asked as a cancel.
- **Both wrong:** "drop it for now, we'll come back to it next month".

### Hybrid, mini, vs rules (fixed 4, broken 10, both wrong 3)

- **Fixed:** Sorani "No", "can we lose the subtitle?", "the logo looks squashed", "fantastic, my boss is really happy with it".
- **Broken:**
  - "never mind", "ok never mind": read as thanks. They are bare cancels, which the rules ask about.
  - "stop": read as hold.
  - The two emoji, "hmm": asked.
  - "Quality Assurance Workshop, 22 October": read as a deadline, told to the office.
  - "do a better design for the conference": paid redo.
  - "Nawroz" and Sorani "Nawroz": read as conversation.
- **Both wrong:** "no" and "nope" (read as thanks), "drop it for now, …".

## Recommendation: keep the rules

1. **Do not switch to model-first.** On Sol it is right more often only on new phrasing:
   - round 3: 16 vs 14;
   - all held-out cases: 51 vs 49.

   Against that, it breaks 19 cases the rules get right (21 in sample 2) and fixes 7, falls below the rules on six intents, and makes costly errors in both samples. It also costs about $0.0028 and 2 s per message, on every message. On mini it is cheap and fast, but it misreads Sorani cancels and holds (Sorani 71–75 of 89, cancel recall 67–69 %).

2. **Do not add the hybrid either.** It is the cheapest way to get the model's gains:
   - 21.6 % of messages call the model;
   - about $0.00006 per message on mini, $0.0006 on Sol.

   Even so, on both models it scores below rules-only and lowers recall on `unclear` and `conversation`. Its losses include an open on a standing rule (Sol) and a paid redo (both models).

3. **Look at the production router next.** This branch does not change it; that needs an ADR and the owner's decision. On this set the router is a net loss: 344 against 349 without it. It also starts a paid redo for "do a better design for the conference", which the rules deliberately ask about. Two options:
   - Turn it off. That is the rules-only score.
   - Narrow it: keep it from turning redo-or-new words into a paid redo, and from turning fragments with no edit in them into change notes.

   Either way, the decision should be measured with this script. A cached rerun is free; a fresh Sol pass of the router is about $0.02.

4. **Harvest what the model showed is learnable, as rules, with new held-out cases written before the fix.** These cases were fixed by Sol in both samples:
   - "can we lose the subtitle?" (a question that removes a part);
   - "the logo looks squashed" (a complaint about a part);
   - "drop it for now, we'll come back to it next month" (a temporary stop);
   - "fantastic, my boss is really happy with it" (praise);
   - bare "no" or "nope" on a draft.

## Caveats

- **The original 302 cases were tuned on by the rules (ADR-272).** The comparison there favours the rules. The held-out cases are the fair signal, but there are only 54, all English, and round 3 is 18. A difference of two cases there is not significant.
- **Several model losses are judgement calls in the labels.** For example, fragments read as change notes kept for the office, or "stop", "wait" and "hold on" read as a pause. Relaxing those labels would not remove the costly errors: the opens on standing rules and the paid redo.
- **The prompt author had read the README's failure list.** The variant prompt gives definitions of the planner's intents and no example phrases. One definition, "removing or dropping a part of a design is a change", restates an ADR-272 rule that the eval also tests. The held-out results are therefore not perfectly blind for the variant.
- **The production arm stubs only the ledger.** It assumes the client's consent and an admitting allowance. Everything that decides the reading is the production code itself.
- **Sorani labels still need native review** before the Sorani rows are treated as ground truth.

## Reproduce

```bash
# Free: every answer is cached in output/nlu-model-first/ (gitignored).
npx tsx scripts/experiments/nlu-model-first.ts                                          # Sol, sample 1
npx tsx scripts/experiments/nlu-model-first.ts --cache cache-sample2 --tag sample2      # Sol, sample 2
npx tsx scripts/experiments/nlu-model-first.ts --variant-model gpt-4.1-mini --tag mini  # mini, sample 1
npx tsx scripts/experiments/nlu-model-first.ts --variant-model gpt-4.1-mini --cache cache-sample2 --tag mini-sample2
# Paid: add --live, with the provider key loaded into the environment of that one process only (never echoed),
# and --cap <USD>. The cap counts every cache file. Each call must fit, at its worst-case reservation, under the cap.
```

The reports are written to `output/nlu-model-first/results-<tag>.json`. Each holds every case's outcome, the model's decision and the guard that fired.
