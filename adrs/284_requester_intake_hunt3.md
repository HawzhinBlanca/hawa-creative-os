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

## Addendum: live canary 2026-10-03

**Date:** 2026-10-03. **Status:** implemented on branch `claude/canaryfriction` (from `claude/release-3`); not deployed.
**Changes a foundation:** no. No migration, no new dependency, no paid call. The new requester lines join two existing lines in each language; no new Sorani wording.

A live canary run on production (release 8e8425dc), from a chat bound to no organisation, sent "Hi! Could you make a poster announcing our staff workshop on Thursday 9 October at 10am in the main hall? Thanks so much", answered "Who is this design for?" (ADR-235) with "not sure", and later wrote "the poster looks cheap". Each friction below has a route-level test that failed first (`apps/core/test/canary-friction-2026-10-03.test.ts`, 33 tests, 26 failing before the fix; the 7 that passed are unchanged titles and the named-organisation control), and a worker test (`apps/worker/test/request-lifecycle-open.test.ts`).

### F2: one message when the office chooses the organisation

**Before.** Core said "No problem. I've passed it to the office, and they'll choose the organisation." beside the open (`notice`), and RequestLifecycle then acknowledged the open with "Got it. A designer will make <title> and send it to you here.": two messages back to back. "I couldn't match that to an organisation…" (an organisation nobody knows), "It's been a while since I asked…" (an answer after thirty minutes) and "I haven't heard who this design is for…" (the timeout) doubled up the same way.

**Decision.** The request's first answer says both, once: "No problem. I've passed it to the office, and they'll choose the organisation. A designer will make <title> and send it to you here." (and the same for the other three outcomes). Each line is the existing answer followed by the designer's line of `receivedForDesigner`, in English and in Sorani (`clientQuestion.*Designer`, listed in SORANI_REVIEW.md). It is in the language of the answer to the question, as before; the request keeps the brief's language for everything after.
- Core records how the question ended on the new-brief decision (`clientChoice: { outcome, lang }`, outcomes `office`, `unmatched`, `expired`, `timeout`) and returns it from the request's first projection. Core says nothing beside the open.
- RequestLifecycle's acknowledgement (key `<request>:1:ack`, sent only once the request is really open) uses the joined line when the projection carries `clientChoice`; anything else gets the usual line. A requester hold still says "paused" first.
- The timeout's notice (`client-question:<update>`) is said only when the kept brief does not open after all; a replay of a timeout that opened says nothing beside the open.
- The office alert is unchanged.

**Deploy order.** Core and the worker ship together (one release directory). A worker from before this addendum ignores `clientChoice` and says only "A designer will make …"; a Core from before it keeps the old two messages.

### F3: a title names the thing

**Before.** That brief was titled "Staff workshop on Thursday 9 October at 10am in the main…" for the requester and the office everywhere.

**Decision.** `titleName` (`apps/core/src/services/request-title.ts`), used by both title paths (`requestTitle` and the copy reader's `copyTitle`), stops the name before the date, time or place said after it: " on <weekday or date>", " at <time>", " this/next <weekday, week…>", " from … to …", ", <date>", " in <month>", " in/at the <place>" (a place only after a name of two words or more, so "Art in the Park" keeps its words), and the Sorani date, hour, weekday and hall/hotel/park phrases. A weekday needs a word before it ("Black Friday Sale" is a name). An audience said with a word for people ("for school principals", "for all students") goes with the date it was said beside, or when the name would not fit whole; otherwise it stays, so the existing titles "KAAE: Quality Assurance Workshop for university deans" and "KAAE: Assessment Literacy Workshop for school principals" are unchanged. A short Latin name taken out of a longer phrase is title-cased ("Staff Workshop"), small words kept small; a name the requester wrote whole keeps their words and casing ("KAAE: Staff football tournament", "Poster for the graduation ceremony"). Only the title changes: the copy keeps every word.

Titles of realistic office briefs, opened through intake (the live brief, the labelled NLU set's briefs and five more; "not sure" answers where the question is asked):

| Brief | Before | After |
|---|---|---|
| live canary (staff workshop, Thursday 9 October 10am, main hall) | Sewa: Staff workshop on Thursday 9 October at 10am in the main… | Sewa: Staff Workshop |
| graduation ceremony on 20 June at 6pm at the Rotana Hotel | Sewa: Graduation ceremony on 20 June at 6pm at the Rotana Hotel | Sewa: Graduation Ceremony |
| book fair from 9 to 12 November at the Family Mall | Sewa: Book fair from 9 to 12 November at the Family Mall | Sewa: Book Fair |
| parents meeting this Thursday at 4pm in the school hall | Sewa: Parents meeting this Thursday at 4pm in the school hall | Sewa: Parents Meeting |
| post for the science fair next week for all students | Sewa: Post for the science fair next week for all s… | Sewa: Post for the Science Fair |
| en-brief-01 (KAAE's QA Workshop for university deans) | KAAE: Quality Assurance Workshop for university deans | unchanged |
| en-brief-02 (Assessment Literacy Workshop) | KAAE: Assessment Literacy Workshop for school principals | unchanged |
| en-brief-03 (Teacher Appreciation Day) | KAAE: Teacher Appreciation Day | unchanged |
| en-brief-04 (QA Workshop for principals on 22 October) | Sewa: Quality Assurance Workshop for school principals on 22… | Sewa: Quality Assurance Workshop |
| en-brief-06 (laid-out members evening) | KAAE members evening | unchanged |
| en-brief-07 (Nawroz party on 20 March at a park) | KAAE Nawroz party on 20 March 2027 at Sami Abdulrahman Park | KAAE Nawroz Party |
| en-brief-11 (misspelt conference brief) | KAAE confrence on 5 novmber at rotana hotell,… | KAAE Confrence |
| en-brief-12 (Chess Club tournament, 8 November) | Sewa: Erbil Chess Club tournament, 8 November 2026 | Sewa: Erbil Chess Club Tournament |
| en-brief-17 (board dinner on 30 October) | KAAE board dinner on 30 October 2026 at 8 pm, Divan Hotel | KAAE Board Dinner |
| en-brief-18 (info session on 6 November) | KAAE: Accreditation info session on 6 November 2026 at 11 am… | KAAE: Accreditation Info Session |
| en-brief-21 (invitation card, graduation ceremony, 5 October) | Sewa: Invitation card for the graduation ceremony,… | Sewa: Invitation Card for the Graduation Ceremony |
| en-brief-22 (open day on 20 October at the campus) | KAAE open day on 20 October 2026 at the campus, 10 am | KAAE Open Day |
| en-brief-27 (staff football tournament, 14 November) | KAAE staff football tournament, 14 November 2… | KAAE Staff Football Tournament |
| ckb-brief-02 (Nawroz celebration on 20 March at a park) | the name, then "on 20 March in Sami Abdulrahman Park" | the name only |
| ckb-brief-03 (graduation, 12 October, Rotana Hotel) | the name, then ", 12 October, Rotana Hotel" | the name only |
| ckb-brief-01 (laid out, date on its own line) | unchanged (its request lead-in stays, see below) | unchanged |
| ckb-brief-12 (teachers' course, 10 November, KAAE hall) | lead-in, name, date, cut at 45 | date gone; still cut at 45 by its lead-in |
| ho-brief-01 (staff picnic on Friday) | Sewa: There, we need something for our staff picnic… | Sewa: There, we need something for our staff picnic |
| ho-brief-03 (science fair next week) | Sewa: Could you do something for the science fair n… | Sewa: Could you do something for the science fair |

No title became empty or lost its event's name (the test checks that each name is the requester's own words, in order). Names that only look like a date or a place keep their words ("Art in the Park", "Black Friday Sale", "Run for Hope", "Erbil Book Fair 2026", "KAAE K-12 Pilot Study", "Graduation at the Rotana Hotel").

**Not addressed (request lead-ins and greetings, not tails).** "Could we get a flyer and an Instagram post for the Quality Week launch…", "Hi there, we need something for…", "hey, could you do something for…", the Sorani "we want a (new) poster for …" lead-in, and a Sorani brief whose first line is only a greeting (titled with the greeting; the copy reader also prints that greeting line) keep their old titles. The last one is a copy bug, not a title one, and needs its own fix.

The natural-language stress script S156 matched the football poster's title as "…football" in small letters; its pattern now ignores case (the title is "KAAE Staff Football Tournament").

### F4: an opinion before any draft goes to the designer

**Before.** With that request open for a designer and no draft yet, "the poster looks cheap" was asked "Is this a change to <title>, or a new design?".

**Decision.** `feedbackBeforeAnyDraft` (`requester-turn.ts`): when the sender's only open request is with a designer and has no draft yet (`manual` at revision 1 or 2: not waiting for the requester's changes), and words the rules cannot place are about the design ("the poster…", "it", "this design", Sorani "the design") with no brief copy, no subject of their own and no ask for a design, the plan is a note on that request (`note`, `feedback: true`). The requester hears "A designer at the office is working on <title>, so I've passed what you said to them; they'll follow up here." (`redoPassedDesigner`, existing in both languages), and the office gets its usual note alert. No question, no paid round, no router call (the plan is not a question). With a draft (`manual` at revision 3 or more), a draft being made (`designing`), or several requests open, the question stays as before.

### Verification

- New: `canary-friction-2026-10-03.test.ts` 33 tests (26 failed before the fix); worker open test 1 (failed before).
- Updated to the single message: four ADR-235 tests in `client-question-and-line-capitals.test.ts` now check that Core says nothing beside the open and that the first projection carries the outcome; S156's title pattern ignores case.
- NLU evaluation unchanged: 349/356, original 300/302, costly errors 0 (no labelled case has a request with a designer).
