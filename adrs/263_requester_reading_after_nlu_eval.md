# ADR-263: The Requester Rules After the NLU Evaluation

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/nlu-eval` (from `bc0d4ac0`); not deployed.
**Requirements:** FR-005 (requester messages), FR-004 (one logical decision per message, no duplicate task), natural-language-only rule (owner, 2026-09-29).
**Changes a foundation:** no. No migration, no new dependency, no new paid call, no new phrase, no new question type.
**Builds on:**
- ADR-144: one planned action per requester message (`requester-turn.ts`).
- ADR-200 addendum: redo words.
- ADR-230 and its addendum (L12, L17): a requester's cancel withdraws; uncertain cancels are asked about.
- ADR-250: words that edit a design on the way are a change.
- ADR-251: a cancel that names nothing is asked about first.
- ADR-252: the conversation answer for a bare "no" after a draft.
- ADR-255: a cancel question never offers "a new design".

**Number:** 263. Checked free across every branch and worktree on 2026-10-02 (Codex holds 241/242/256/259/260).

## 1. Context

The labelled NLU set (`apps/core/test/fixtures/nlu-eval/utterances.json`, `plans/nlu-eval-2026-10-02/README.md`) scored the rules-only reader at 93.0 % (281/302), and 84.3 % on the synthetic cases. Three errors were costly:

- `en-change-39`: in review, "the workshop is for university deans, not school principals" opened a second request.
- `ckb-change-14`: in review, the Sorani for "make another design, a better one" opened a second request.
- `en-cancel-29`: "forget about it" withdrew the only design without asking.

The largest failure class (10 of 21) was the change-or-new question used as a catch-all. With one design in review, plain edit words ("take the phone number out", "no KAAE in the headline please", "hmm the font is hard to read", "please cancel the gold border", "stop using that font") were asked "Is this a change to …, or a new design?". Holds, relaxed deadlines and praise fell into the same question, and so did a Sorani named cancel with a reason (the L17 shape). That question also offered "a new design" for cancel words.

## 2. Decision

All changes are in `readIntentByRules` and `planTurn` (`apps/core/src/services/requester-turn.ts`). Each rule reads a kind of wording, not a listed sentence.

### 2.1 Costly errors

1. **A dismissal names nothing.** "Forget it", "forget about it", "just forget that", "oh well, forget about it then" are read like "never mind": a bare cancel, asked about first (ADR-251). A cancel that names the design still withdraws it: "forget the poster", "forget about the workshop poster", "forget it, we don't need it anymore".
   - This changes ADR-251's test list. `requester-turn-confirmations.test.ts` had "forget it" among the words that name the design. It now sits with "never mind", and "forget the poster" and "forget it, we don't need it anymore" take its place on the naming side. Asking costs one message; a wrong withdrawal cannot be undone (ADR-252).
2. **A correction is a change.** Words that say what the design says and what it should not say are a change: "the workshop is for university deans, not school principals", "it's for the teachers, not the parents", "the event is on Thursday, not Wednesday". They must be said of the design ("the …", "it's …") and carry no date or time. Words with a date or time stay a brief, and ADR-250 decides between a brief and a change for them.
3. **Another, better design is a redo.** "Another one / design / version" said together with what should be better ("better", "nicer", "more professional"), with no subject of its own, is redo words: the design on the way again, better (ADR-200 addendum). Examples: "make another design, a better one", its Sorani form, "do another one, but better". With a subject of its own ("another poster for the open day, a better one") the requester is asked "redo or new?" as before.

### 2.2 Edit words about a design on the way

`readsAsChange` now reads five more kinds of edit. A design part is the head of what is named (title, headline, logo, phone number, QR code, border, shadow, font, colours, background and the like). A word inside a design's name ("the Teacher Day poster") is not a part.

| Kind | Examples |
|---|---|
| Cancel or stop said of a part | "please cancel the gold border", "cancel the shadow behind the title", "drop that shadow" |
| A styling instruction in the negative | "stop using that font", "please don't use red anywhere" |
| A part left out | "no KAAE in the headline please", "no logo on the bottom please" |
| A part found wanting | "hmm the font is hard to read", "the text is way too small", "the photo is cut off" |
| A correction (2.1.2) | "the workshop is in the main hall, not the library" |

A change goes through `planTurn`'s change rules, which are unchanged:
- A design being made or with the office keeps the change for the office (ADR-230).
- A design that waits for the requester's changes starts a round only when it is known for certain, for example as the only candidate. Recency never starts a round.
- With two designs and no name, the requester is asked which design. "A new design" is not offered.

**Cancel words said of a part never withdraw.** "Cancel the logo on the poster" used to read as a named cancel of the poster. The cancel rules now skip a clause whose object is a part. The intake router's catch-all for cancel words skips it too: "please cancel the gold frame on the Teacher Appreciation Day poster" is a change to that design.

### 2.3 Cancel words never offer a new design

- **A longer Sorani named cancel.** A Sorani clause of up to eight words that ends with a cancel verb carrying its object is a cancel. Sorani puts the verb last, and the old limit was four words. Sorani reasons after a cancel are read like the English ones: "it was only a test", "it was by mistake", "I sent it by mistake". The live L17 shape, said in Sorani, now withdraws the design it names.
- **Sorani cancel verbs the rules cannot place** are cancel words (`cancelWords`), as English ones are (ADR-230 addendum). They are asked about among the designs that can be withdrawn.
- **No "new design" option.** Any question about words that contain a cancel verb (English "cancel", "withdraw", "scrap", "abort", or the Sorani cancel verbs) never offers "a new design".
- **Someone else making it is a reason to cancel.** "We'll do it ourselves", "we found another designer" and "someone else is doing it" are cancel reasons. So "don't make it, we'll do it ourselves" withdraws the design it names.

### 2.4 Holds, timing, praise, status and briefs

- **Hold.** A stop said with "yet", "for now", "for the moment" or "until …" pauses the design.
  - English: "don't continue with the design for now, …", "don't go ahead with the poster yet", "please stop working on it for now", "hold off until …".
  - Sorani: "don't make it yet" ("yet" together with a "don't" verb).
  - "Go ahead" said in the negative is never approval. Before, "don't go ahead with the poster yet" told the office it was approved.
- **Timing.** These tell the office the timing: "no rush", "no hurry", "take your time", "not urgent", and a day said to be fine ("next week is fine", "Sunday is fine", "next week works").
- **Praise.** Praise with a clause saying someone likes the design is thanks ("looks great, the manager loves it", Sorani "very beautiful, the client likes it"). Approval stays the office's (ADR-022). Approval or change words beside the praise are still read first.
- **Status.** Status questions may name the design in up to four words and say "coming along", "coming on", "getting on" or "progressing" ("how's the workshop poster coming along?").
- **Briefs.** A design asked for without naming its kind is a brief: "we need something for the KAAE alumni meetup next month", "I'd like something to promote the summer school". It opens for a person because it carries no copy. "Something for the title" is not a brief. "I'd like" / "we'd like" now count as asking for a design: the old pattern needed a space before "'d".

### 2.5 Fragments

A fragment of up to four words that only names a subject or an event ("for the deans", "about the gala", "Nawroz", Sorani "Nawroz") gets the existing change-or-new question when a design is on the way. With nothing on the way, the chat answer greets the requester as before. No new question type is added.

A bare "no" after a draft stays the conversation's. ADR-252 answers it with the design's status and "If you'd like anything changed, just tell me what."

## 3. Consequences

**The evaluation's original 302 cases** (the README baseline, compared with this branch):

| | Before | After |
|---|---|---|
| Overall | 281/302 (93.0 %) | 300/302 (99.3 %) |
| Synthetic | 86/102 (84.3 %) | 101/102 (99.0 %) |
| Live bugs | 57/60 | 59/60 |
| Repo fixtures | 138/140 | 140/140 |
| Costly errors | 3 | 0 |
| Target accuracy | 148/160 | 160/160 |

The original set was tuned on, so its score overstates how well the rules generalise.

**The held-out cases** are 54 English cases added to the fixture with `heldOut: true`. They were written before the fixes:

| Round | Cases | Written | Before any fix | First pass | Final |
|---|---|---|---|---|---|
| 1 | 32 | before any fix | 5/32 | 29/32 | 31/32 (two of its failures informed the follow-up fix) |
| 2 | 4 | before the follow-up fix | — | 1/4 | 4/4 |
| 3 | 18 | after all fixes; never tuned on | — | — | 14/18 (77.8 %) |

Round 3 is the honest estimate of unseen phrasing. All held-out costly errors are 0 after the fixes. Before the fixes, round 1 had six that the scorer counts as costly:
- two dismissals withdrew a design;
- a correction and a redo opened a request;
- a cancel of a part asked whether to withdraw the whole design;
- a hold was read as approval.

**Remaining failures:**
- The bare "no" on a draft (English and Sorani) and "nope". This is ADR-252 behaviour, by design.
- "Can we lose the subtitle?" is forwarded as a question.
- "The logo looks squashed": the complaint word is not in the closed list.
- "Drop it for now, we'll come back to it next month" is not read as a hold.
- "Fantastic, my boss is really happy with it" is not read as praise: "my boss" is not a known subject.

These show the limit of closed lists. A model-first reader with these rules kept as hard guards remains the README's recommendation.

**Behaviour changes a requester may notice:**
- "Forget it" asks before it withdraws.
- "Stop for now" pauses the design instead of asking "Do you want me to cancel …?".
- Short edit words about a design in review are kept for the office (the Desk's Deliver gate) instead of asking "change or new?".

## 4. Verification

- **`apps/core/test/requester-turn-nlu-eval-fixes.test.ts`** (64 tests). It runs the plans exactly as intake does: rules, `planTurn`, then ADR-250's `reconsiderNewBrief`.
  - Red before: against `bc0d4ac0`'s `requester-turn.ts`, 52 fail and 12 pass. The 12 that pass guard behaviour that must stay: "go ahead" is approval, praise with change words is a change, real new briefs open, a bare "no" stays the conversation's.
- **`apps/core/test/requester-turn-confirmations.test.ts`**: "forget it" moved from the naming list to the bare list (section 2.1).
- **`apps/core/test/nlu-eval.test.ts`** reports the original set and the held-out set separately (`perSet`). It also checks that a held-out case is marked synthetic.
- Full `apps/core` suite, `pnpm typecheck` and `pnpm lint`: see the commit message.
- **Native review.** The Sorani reasons, "don't make it yet", "likes it", and the one synthetic Sorani test line ("we'll talk about it later") need native review. They are listed here because no catalogue phrase changed.
