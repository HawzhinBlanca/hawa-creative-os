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
| ckb-brief-01 (laid out, date on its own line) | greeting and request words in the name | the event's name only (follow-up below) |
| ckb-brief-12 (teachers' course, 10 November, KAAE hall) | lead-in, name, date, cut at 45 | the course's name only (follow-up below) |
| ho-brief-01 (staff picnic on Friday) | Sewa: There, we need something for our staff picnic… | Sewa: Staff Picnic (follow-up below) |
| ho-brief-03 (science fair next week) | Sewa: Could you do something for the science fair n… | Sewa: Science Fair (follow-up below) |

No title became empty or lost its event's name (the test checks that each name is the requester's own words, in order). Names that only look like a date or a place keep their words ("Art in the Park", "Black Friday Sale", "Run for Hope", "Erbil Book Fair 2026", "KAAE K-12 Pilot Study", "Graduation at the Rotana Hotel").

**Request lead-ins and greetings** were left to the follow-up below.

The natural-language stress script S156 matched the football poster's title as "…football" in small letters; its pattern now ignores case (the title is "KAAE Staff Football Tournament").

### F4: an opinion before any draft goes to the designer

**Before.** With that request open for a designer and no draft yet, "the poster looks cheap" was asked "Is this a change to <title>, or a new design?".

**Decision.** `feedbackBeforeAnyDraft` (`requester-turn.ts`): when the sender's only open request is with a designer and has no draft yet (`manual` at revision 1 or 2: not waiting for the requester's changes), and words the rules cannot place are about the design ("the poster…", "it", "this design", Sorani "the design") with no brief copy, no subject of their own and no ask for a design, the plan is a note on that request (`note`, `feedback: true`). The requester hears "A designer at the office is working on <title>, so I've passed what you said to them; they'll follow up here." (`redoPassedDesigner`, existing in both languages), and the office gets its usual note alert. No question, no paid round, no router call (the plan is not a question). With a draft (`manual` at revision 3 or more), a draft being made (`designing`), or several requests open, the question stays as before.

### Verification

- New: `canary-friction-2026-10-03.test.ts` 33 tests (26 failed before the fix); worker open test 1 (failed before).
- Updated to the single message: four ADR-235 tests in `client-question-and-line-capitals.test.ts` now check that Core says nothing beside the open and that the first projection carries the outcome; S156's title pattern ignores case.
- NLU evaluation unchanged: 349/356, original 300/302, costly errors 0 (no labelled case has a request with a designer).

### Follow-up (2026-10-03): a greeting is never copy, and never the name

**Before.** A brief whose first line or first words were only a greeting printed the greeting as the design's headline and named the design after it: Sorani "hello brother" (and "hello", "hello sirs", "good morning") above a request line, a Sorani greeting and form of address before the request in one sentence, and a greeting line above laid-out copy in Sorani, English ("Hello") and Arabic ("peace be upon you"). English "Hi!" before a request sentence was already fixed in d17bae2d. The Sorani "hello, we want a poster for …" (no "make") printed the greeting and the request words whole; "Could we get a flyer and …" and "we're hoping for something for …" printed the request sentence whole; "Hi there, we need something for …" and "could you do something for …" named the design after the request.

**Decision.**
- `greetings.ts`: one list of greetings and forms of address in English, Sorani and Arabic (needs native review), used by the copy reader's greeting, lead-in and chat rules, by `GREETING_ONLY`, and by the title.
- `chat-campaign-intake.ts`: a first line that is only a greeting, with more below it, is kept with the instructions and is not the headline. Below it the opening is read as before, except a request line that carries the event's name, which stays for the copy reader (`copyBesideRequest`), so "Good morning everyone / Could you design a poster for our Annual Accreditation Conference? / …" keeps the name. Without a greeting nothing changes. A greeting that is part of the copy ("Hello Summer!") stays.
- Copy reader: Sorani "<a poster>-we want for …" (دەوێت) is a request; English "could/can we get/have …" and "we're hoping for …" are requests.
- Title: a greeting with whom it greets ("Hi there,") and a design asked for as "something for …" lead to the subject ("Staff Picnic", "Science Fair", "Graduation Party").
- The copy keeps the requester's words verbatim: only greetings and request words are left out.

**Not addressed.** Arabic requests ("please design a poster for …") are not read as requests at all; such a brief opens for a designer with its request line as the name. A request line whose only words beside the request are not the client's name, without a greeting above it ("I need a poster for the launch, keep it formal"), keeps its old reading.

**Verification.** 16 new route tests in `canary-friction-2026-10-03.test.ts` (14 failed before the fix; the two controls, a greeting above a request that carries the name and "Hello Summer!", passed); four rows of the F3 title table now expect the better names.

## Addendum: the client named as the addressee (2026-10-03)

**Date:** 2026-10-03. **Status:** implemented on branch `claude/clientprefix` (from `claude/release-3` b7541da6); not deployed.
**Changes a foundation:** no. No migration, no new dependency, no paid call, no new requester wording.

**Before.** Naming who the design is for at the start of the request printed the client's name as copy and spoiled the title. Reproduced at route level (`/v1/internal/telegram/intake`, the office owner's chat):

| Brief | Before (title; copy) | After (title; copy) |
|---|---|---|
| For KAAE, could you design a poster for our Quality Week on 12 November at the Rotana Hotel? | KAAE: For KAAE; "For KAAE", "Quality Week on 12 November at the Rotana Hotel" | KAAE: Quality Week; "Quality Week on 12 November at the Rotana Hotel" |
| For KAAE: please make a poster announcing the Assessment Literacy Workshop on 5 November. | KAAE: For KAAE; "For KAAE", "Assessment Literacy Workshop on 5 November" | KAAE: Assessment Literacy Workshop; "Assessment Literacy Workshop on 5 November" |
| KAAE - could you design an Instagram post for our Open Day on 20 October? | KAAE; "KAAE", "Open Day on 20 October" | KAAE: Open Day; "Open Day on 20 October" |
| Could you design a poster for KAAE for our Quality Week on 12 November? | KAAE for Our Quality Week; "KAAE for our Quality Week on 12 November" | KAAE: Quality Week; "Quality Week on 12 November" |
| To KAAE, we need a flyer about the Accreditation Info Session on 6 November 2026 at 11 am. | KAAE: To KAAE; "To KAAE", … | KAAE: Accreditation Info Session; the session line only |
| KAAE: can you make a banner for the Teacher Appreciation Day? It's on 20 October 2026 … | KAAE; "KAAE", … | KAAE: Teacher Appreciation Day; the name and the date line |
| Hi team, for KAAE, could you design a poster for our Book Fair on 5 November? | KAAE: For KAAE; "For KAAE", … | KAAE: Book Fair; "Book Fair on 5 November" |
| For the Kurdistan Accrediting Association for Education, could you design … Quality Week … | KAAE: Kurdistan Accrediting Association for Education | KAAE: Quality Week |
| Could you make a poster for KAAE announcing the Science Fair on 14 November 2026 at 9:00 AM? | KAAE Announcing the Science Fair | KAAE: Science Fair |
| We'd like an Instagram story for KAAE, about the Open Day on 20 October 2026 at the campus. | KAAE, About the Open Day | KAAE: Open Day |
| "For KAAE:" on a line of its own above the request | KAAE: For KAAE | KAAE: Quality Week |
| Sorani "for KAAE, please make a poster for <event> …" | KAAE; "KAAE" as headline | KAAE: <event>; the event and its date line |
| Sorani "please make a poster for KAAE for <event> …" | "KAAE for <event>" as headline and title | KAAE: <event> |
| Sorani "please make a poster for KAAE, make it, for <event> …" | "KAAE make it for <event>" as headline and title (the verb was printed too) | KAAE: <event> |

Each result is the same copy and title as the same brief without the client reference, opened for KAAE through the client question.

**Decision** (`request-copy-extraction.ts`, `withAddressee`). Who a design is for is part of the request, never its copy: the logo names the client. In `extractRequestCopy` the request spans are extended over the client named as the addressee before the rules, the guard's forbidden spans and the receipt's request words are computed, so a model reading cannot print it either. `copyBesideRequest` (the greeting-line rule in `chat-campaign-intake.ts`) uses the same spans.
- **Which names.** Only the names of the client the request was resolved to (`clientNamesFor`: the pack's code, label, display and full names, aliases; routing nouns such as "university" excluded), as intake resolved it today. No capitalised-word heuristic; the client resolution is unchanged.
- **Where.** (1) Before the ask in its sentence, with only greetings or lead-ins beside it: "For KAAE,", "For KAAE:", "To KAAE,", "For the <full name>,", "KAAE -", "KAAE:", Sorani "for KAAE," (بۆ KAAE،). (2) A line or sentence that only names the addressee, directly above a sentence that opens with an ask. (3) Right after a design asked "for": the name followed by what the design is for ("for our …", "about …", "announcing …", "on …", optionally after a comma) or by the end of the sentence; Sorani "<a poster> for KAAE (make) for …".
- **What stays.** A name followed by anything else is the requester's copy: "the KAAE Open Day", "KAAE Open Day", "For KAAE members", "at the KAAE library", "KAAE's …" (ADR-253 as before), quoted words ("KAAE welcomes you") and laid-out lines.
- **Nothing else to print.** "Could you design a poster for KAAE?" carries no copy; it opens for a designer as a request without copy does (ADR-232 rule 6), never printing "KAAE".

**Not addressed.** A client known only in `hawa.clients` (no client pack) has no names here, so its addressee is still copy. A request that names another client than the one the chat is bound to keeps that name. Sorani "for the KAAE association" (with a Sorani noun before the name) and Arabic requests are not covered. The Sorani phrases in the tests need a native speaker's review.

**Verification.** `apps/core/test/client-named-as-addressee.test.ts`, 23 tests: the 14 briefs above at route level, each compared with the same brief without the client; the four live briefs exactly; a model reading whose lines name the addressee (refused by the guard) and whose headline is the addressee (falls back to the rules); and 7 must-stay controls. 16 failed before the fix (the 7 controls passed before and after). The 49 intake, requester, client-question, lifecycle-source, routing, chat, turn, canary, copy, title and NLU test files: 1184 passed, 1 skipped. NLU evaluation unchanged: 349/356, original 300/302, held out 49/54, costly errors 0. `pnpm typecheck` and `pnpm lint` pass.

## Addendum: brief phrasing fuzz: copy classes (2026-10-03)

**Date:** 2026-10-03. **Status:** implemented on branch `claude/copyfix` (from `claude/release-3` a1df7f51); not deployed.
**Changes a foundation:** no. No migration, no new dependency, no paid call, no new requester wording.

**Before.** The brief phrasing fuzz (`apps/core/test/brief-phrasing-fuzz.test.ts`, report `output/research/2026-10-03-brief-fuzz/REPORT.md`) put 428 seeded briefs through `/v1/internal/telegram/intake` and found 490 violations. Nine of its eleven root-cause classes are in the copy reader (`request-copy-extraction.ts`) and the laid-out brief's reader (`chat-campaign-intake.ts`):

| Class | Brief (shortened) | Before | After |
|---|---|---|---|
| 1 closings | `… Book Fair on 5 November?⏎Best regards,⏎Ahmed` | `Book Fair on 5 November` / `Ahmed` | `Book Fair on 5 November` |
| 1 | `… Book Fair on 5 November? Many thanks!` | … / `Many thanks` | `Book Fair on 5 November` |
| 1 | `Please make a poster for the Science Camp on 20 March 2027 thanks` | `… 20 March 2027 thanks` | `Science Camp on 20 March 2027` |
| 2 client sentence | `… Book Fair on 5 November? It's for KAAE.` (also "This is for KAAE.", "For KAAE please.", "It is for the <full name>.") | … / `For KAAE` | `Book Fair on 5 November` |
| 3 details tail, list marks | `Hi team,⏎can u make a post with these details:⏎- Nawroz Celebration⏎…` | `With these details` / …; title `KAAE: With these details` | `Nawroz Celebration` / `3rd of December` / …; title `KAAE: Nawroz Celebration` |
| 3 | `Make me a story with these details:⏎* nawroz celebration⏎…` | one block with its `* ` marks; title `KAAE: * nawroz celebration` | one line per item, no marks |
| 4 event first | `Hello, our Open Day is on 5 November. Could you make a poster for it?` | `Our Open Day is on 5 November`; title `KAAE: Our Open Day Is` | `Open Day` / `5 November`; title `KAAE: Open Day` |
| 6 addressee residue | `Could you do a flyer for KAAE please⏎…`, `… a poster for KAAE with these details:` | `KAAE please`, `KAAE with these details` (and as the title) | the copy lines only |
| 6 | Sorani request naming KAAE in its Sorani spelling | the Sorani name as headline and title | the event's lines only |
| 7 glued greeting | `Hello Our Open Day is on 5 November. …` | `Hello Our Open Day is on 5 November` | `Open Day` / `5 November` |
| 9 month abbreviation | `… It's on Oct. 20 in the main campus.` | `Oct` / `20 in the main campus` | `Oct. 20 in the main campus` |
| 10 bare "need" | `need a poster for the Book Fair on 5 November.` | the whole message | `Book Fair on 5 November` |
| 11 long sentence | a request whose headline would be 113 characters | no copy (opened for a designer) | `Upcoming KAAE Quality Assurance Workshop` / `For parents and students` / `Monday 12 November at 2 pm in the main campus` |

**Decision.** Only words are left out, or a line is split where the requester's own words already part; nothing is reworded, and every line is still rebuilt by the guard from the requester's characters (I1 stayed 0).
- **Closings (class 1).** `closingStart` finds the closing at the very end of a brief: thanks, "Many thanks", "Thanks a lot/in advance", cheers, (best/kind/warm) regards, best wishes, sincerely, with the sender's name after a comma (on the same or the next line), and a "pls" left before it. It is taken off when a sentence or line break or a comma stands before it, when it is glued to a detail ending in a date, time, day, month or "pls", or when it has more than one word or a name. One closing word glued to a name stays ("A Night of Thanks"). The rules stop at it, the guard forbids it, the receipt records it (`copyExtraction.closing`), and a laid-out brief peels it (`peelClosingInstructions`). "Many thanks!" is a closing sentence; "regards" is a sign-off only before a comma or the end, or in lower case before a name ("Best regards Ahmed"), so "Best Regards Gala" (which printed nothing before) is copy.
- **Whom it is for (classes 2 and 6).** A sentence, or the end of one, that only says whom the design is for ("It's for / This is for / For <client> (please)", "It is for the <full name>") is part of the request, anywhere in the brief, for the rules, the guard and a laid-out brief's last line. After a design asked "for <client>", "please", "with these details:" and ":" close the request too. Only the resolved client's names (`clientNamesFor`), now with the pack's routing phrases (the Sorani spelling of KAAE; the Sorani nouns for "university" and "accreditation" are excluded, as their English forms are); a name in Arabic script may repeat its last word (the spelled-out letters). "For KAAE members", "KAAE Open Day" stay.
- **Details tail and list marks (class 3).** "with these/the following details", "with this text", "as follows" (and the like), with "please" and ":", end the design named after an ask. A laid-out list (two or more lines opening with the same "- ", "* " or "• ") is read one line per item without the marks, as under a line that introduces the copy; the rules drop a leading mark from a piece.
- **Event first and a glued greeting (classes 4 and 7).** The first piece before the first ask is split only at the copula: the name before "is/are/will be (held/taking place/happening) on/at/in" (without a leading "our", "the", "this year's") and the rest after it. The split is not made when the name starts with a pronoun, has more than eight words or a second verb ("The workshop is for all teachers and is on 5 November" stays one line). A greeting glued to that piece is left out before "our/the/this/my/their" or a name in capitals ("Hello Kitty Day" keeps its words).
- **Month abbreviations (class 9).** A sentence does not end after "Jan.", …, "Sept.", "Oct.", "Nov.", "Dec." followed by a number.
- **Bare "need/want a …" (class 10).** At the start of a sentence (after a greeting), "need" and "want" with a design noun within four words are an ask; later in a brief ("Students need a card to enter") they stay copy.
- **A title that names nothing (lead's follow-up).** `copyTitle` reads the next copy line when the headline names nothing (only "With these details", "with this text:", "for this:", a list mark, or `titleName` returning nothing, as it does on `claude/intentfix` for such a line); with no line that names something, the title is the label alone, never "KAAE: ".
- **Long headline (class 11).** A rules headline over 110 characters is split at "on <date>" and then at its last "for …" before the date, before the length check, instead of being dropped.

**Not addressed (other classes, another engineer, in parallel).** Briefs read as instruction-only by `readIntentByRules` (class 5: "Hi pls make …", "Hello We'd like …", numeric/relative dates, a request with only two detail lines, bare "need/want" briefs the turn reader does not take as requests) still open with no copy; the copy reader's side is ready for them. KAAE's full English name is still not routed (class 8). `request-title.ts` `titleName` keeps " on Oct. 20" in a title (it cuts before " on 15 October" but not before an abbreviated month with a period): "KAAE: Spring concert for all teachers on Oct. 20". A laid-out line keeps the client's possessive ("KAAE's Career Fair"; ADR-253 covers headlines taken by the rules or the model only).

**Verification.** `apps/core/test/brief-fuzz-copy-classes.test.ts`, 64 tests (route level, with "KAAE" answered when the bot asks, plus the copy reader and `copyTitle` alone): 52 failed before the fix; the 12 that passed are must-stay controls (quoted copy, "Here is the text:" copy, "Thanks Giving Fair", "Many thanks to our sponsors" in laid-out copy, "Thank you for coming to our fair", "KAAE Open Day", "For KAAE members", "Hello Kitty Day", "Students need a card", copula sentences that are not split, a headline that fits). Fuzz ratchet lowered to the new counts (never raised): total 490 → 101, I1 0 → 0, I2 232 → 0, I3 185 → 30, I4 32 → 30, I5 41 → 41; briefs with a violation 240 → 62. Every remaining I3/I4 violation is a brief opened as instruction-only (class 5); I5 is classes 5 and 8. Of the 229 briefs whose copy or title changed, the 25 that passed before all changed for the better (month abbreviations kept whole, "pls" and a glued client sentence left out). The intake, requester, client-question, client-named, lifecycle-source, NLU, natural, routing, chat, turn, canary, copy, title and fuzz test files: 50 files, 1254 passed, 1 skipped. NLU evaluation unchanged: 349/356, costly errors 0. `pnpm typecheck` and `pnpm lint` pass.
