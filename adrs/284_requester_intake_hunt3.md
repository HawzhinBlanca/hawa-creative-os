# ADR-284: Requester Intake After Bug Hunt 3: Nothing Opens, Withdraws or Starts a Round Unless the Words Mean It

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/hunt3-intake` (from `claude/hunt3-base` d1a17f27); not deployed.
**Requirements:** FR-004 (one logical decision per message, no duplicate task), FR-005 (requester messages), FR-013 (exact copy), natural-language-only rule (owner, 2026-09-29).
**Changes a foundation:** no. No migration, no new dependency, no new paid call, no new phrase in the requester catalogue.
**Builds on:** ADR-144 (one planned action per message), ADR-200 (office turn), ADR-232 (copy from a request sentence), ADR-250 (edits of a design on the way), ADR-251 (cancels that name nothing), ADR-252 (chat answers), ADR-272 (rules after the NLU evaluation).

**Number:** 284. Checked free across every branch and worktree on 2026-10-03 (283 is taken by `composers_measure_each_string_once`).

## 1. Context

Bug hunt 3 ran adversarial requester messages through the real pipeline (`readIntentByRules` → `planTurn` → `reconsiderNewBrief`) in every context, through Core's intake route against the test database, and through the copy reader. The labelled NLU set scored 349/356 with no costly errors before and after, yet the hunt found messages outside it that opened a request, rejected a draft or started a paid round when nothing of the kind was meant, and copy that printed words never meant for the design.

## 2. Decision

Each item is a rule about a kind of wording; each has a test that failed first (`apps/core/test/requester-intake-hunt3.test.ts`, `request-copy-designer-lines.test.ts`, `office-telegram-approval.test.ts` "hunt 3", `packages/domain/test/request-deliverables.test.ts`).

### 2.1 What opens a request

1. **Unplaced words in an empty chat** (`planTurn`, `unplacedWithNothingOnTheWay`). Words the rules cannot place, with nothing on the way, opened whenever the heuristics called them a brief, as a request that drafts by itself ("the event was cancelled", "the poster looks cheap", "not bad"). Now: brief copy of their own (an event with its date or time) opens as before; a subject of their own (an event, a name, a date) without copy opens for a person; anything else goes to the office (`forward`). The office alert says "wrote about a design that is no longer open", not "replied to an older message".
2. **"Substantial"** (`readIntentByRules`). An event word in eight words, or any twenty words, was a brief that opens even while a design is on the way. It now needs the event's details (`carriesBriefCopy`), and twenty words need a date, an event, a name, a number or quoted or labelled copy. Praise, thanks, chat and questions that mention the event no longer open a paid draft.
3. **A brief closed with approval words** ("…, Family Mall. Please send it to me by Thursday.", "… Go ahead!") was approval: nothing opened. Event copy before the first approval phrase makes the words a brief.
4. **Updates of a design on the way** (ADR-250, `brief-or-change.ts`). Event copy said as an update ("sorry the workshop date is …", "it's at the Divan hotel now, …", "we moved the workshop to …", "the seminar is on …", Sorani "postponed") is asked "a change to it, or a new design?" instead of opening. `reconsiderNewBrief` also reads `unclear` words: one that certainly edits a part of the design on the way is its change.
5. **Cancels with their reason** ("ok so the workshop got cancelled, we don't need that poster anymore, sorry for the trouble") were substantial briefs. Cancel reasons know more events and lead-ins; a cancel clause beside words the rules cannot place, or an event said to be called off on its own, is cancel words (asked, never "a new design"). A stop said for a while stays out of this (ADR-272 2.4). Sorani "we don't need the <design>" with its reason withdraws.
6. **A design asked for as "one"** ("can you also make one for the Book Fair on 9 November", "make another for …", "make the same for …") is a new brief.
7. **"…and a story for it"** (`planRequestDeliverables`): a later design whose subject only points back takes the first design's subject instead of opening on the words "a story for it".

### 2.2 What starts a paid round

On a design sent back for the requester's changes, a yes-or-no question about the design ("did you put the date?") is the office's question, and "can you make it by tomorrow?" is timing. Neither starts a round. Item 2.1.6 also ends rounds started with a new design's words.

### 2.3 What rejects a draft (office turn)

An office member's cancel that names nothing ("never mind", "stop", "no need", "forget it"; Sorani "stop", "no need") rejected the only waiting draft with no question. It is now unclear for the office, as ADR-251 makes it for a requester: in reply to a draft the member is asked what to do; otherwise intake reads it.

### 2.4 What is printed

1. **Sentences to the designer** ("Don't forget the logo.", "Send it to me by Thursday.", "Keep it simple.", "Avoid red.", "Regards, Ahmed", "PS: use our colours") are instructions, in the copy reader and its guard.
2. **Closing words of a laid-out brief** to the designer are peeled into the instructions (`peelClosingInstructions`); a closing Sorani "thank you for attending" stays the event's.
3. **Quoted words** keep the date, time and place said beside them: each unquoted stretch with a number is a line, rebuilt by the grounding guard.
4. **Chat before a request** (thanks, praise, greetings, a question to the bot) is not copy; words after it stay.

### 2.5 Language

Words with no letter ("👍", "👎") are answered in the chat's language: `langFor` read the non-empty emoji as English, and the chat answers fell back to the designs' Latin titles.

## 3. Consequences

- **Fewer requests open by themselves.** Short words with a subject but no copy, in an empty chat, open for a designer instead of drafting. A romanised Sorani brief with no date the rules recognise now opens for a designer (its request words were its copy).
- **More questions.** Event copy said as an update while a design is on the way, and cancel words beside unplaced words, are asked about. Each costs the requester one message; each used to cost a second request or a paid draft.
- **Approval words with event copy before them** are a brief. "perfect, send it, the ceremony is on 12 October" stays approval words.
- **Not changed:** a correction or styling message with nothing on the way still opens for a designer (ADR-144's "styling message opens as a manual request", pinned by `lifecycle-internal-intake.test.ts`); a message that both changes one design and asks for another opens the new one only (FR-004's one decision per message).
- **Native review.** The Sorani phrases in `requester-intake-hunt3.test.ts` (K2, U1) and in `request-copy-extraction.ts` (`CKB_DESIGNER`) need a native speaker's review.

## 4. Verification

- NLU evaluation (`apps/core/test/nlu-eval.test.ts`): 349/356 before and after, original set 300/302, held out 49/54, costly errors 0. The context-free rules reading went 340 → 339 (the romanised Sorani brief above).
- `apps/core` full suite: 309 files, 3700 tests pass (3 files, 4 tests skipped); `packages/domain` 21 files, 210 tests; `pnpm typecheck` and `pnpm lint` pass.
