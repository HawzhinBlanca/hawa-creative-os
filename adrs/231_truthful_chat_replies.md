# ADR-231: What the Bot Says Matches What Happens

**Date:** 2026-10-01
**Status:** Implemented and tested on branch `claude/truthful-chat-replies` (from production `b83c9f1d`); not deployed.
**Requirements:** FR-005 (passive messages become work only through an explicit instruction or an approved classifier policy), FR-043 (only the office approves a design), NFR-016 (an office operator does routine work without a command line).
**Changes a foundation:** no. No migration, no dependency, no new paid call.
**Builds on:** ADR-144 (requester intent routing), ADR-145 (requester wording catalogue), ADR-180 (titles), ADR-182 (natural-language stress), ADR-200 and its section 6 (office chat; redo words).
**Number:** 231, reserved for this stream by the lead.

## 1. Context

A live Telegram test against production on 2026-10-01 (owner chat, synthetic updates, bot output read from the Restate journal) found that the bot's words did not match what it did:

- **L2.** "do a better design that's similar to the earlier ones, use more of the photos…" was bound to request 3a4c6ac4. That request had been opened by mistake an hour before, for a designer, and had no draft. The K-12 Pilot Study design delivered that morning was not chosen.
- **L4.** The requester heard "I'll redo … — I've passed what you said to the office, so the new version follows it." The office heard the words were "not applied to any design". No round started.
- **L5.** A status answer said "KAAE K-12 Pilot Study… is being sent to you now" five hours after Telegram confirmed it. It listed the accidental request as being worked on. It named two designs "KAAE K-12 Pilot Study…" with nothing to tell them apart.
- **L6.** Titles began with U+200F. A delivery title named the client twice ("KAAE: ‏KAAE K-12 …"). The caption read "‏KAAE K-12 Pilot Study…, final". A request was titled "Instagram post announcing our Assessment Lite…".
- **L7.** Office alerts read "The requester in chat 7191500129 …", "Task 030996c1-…, request 3a4c6ac4-…" and "Deliver will ask someone in the Desk to read and acknowledge these words first".
- **L10.** The owner's "looks good, send it" got "Which draft do you mean?" with three drafts. Two of them were said to be already approved.
- **L11.** "can you also make videos?" was kept as a change. The requester heard "I've passed your change". Deliver was held until someone read it.

## 2. Decision

### 2.1 Redo words go to a design the requester has seen (L2)

`planRedo` (`requester-turn.ts`) now looks only at requests that have a draft, when any do: `in_review`, `approved`, `delivering`, `delivered`, or `manual` at rev 3 or more (sent back for changes). This rule is `hasDraft`.

- A request opened for a designer, or one still being made for the first time, is not "the earlier one" while another request has a draft.
- A reply still names its own design.
- With no request that has a draft, the old rule applies.
- No model call is added. The intake router's pick is checked against the same pool.

### 2.2 The answer says what happened (L4)

"I'll redo …" (`redoStarted`) is said only when a round starts. Otherwise the words are kept for the office, and the requester hears that, and why nothing started:

| Stage | English |
|---|---|
| being made | "*T* is still being made, so I can't start it again yet. I've kept what you said with it for the office; they'll see it before the design comes to you." |
| with the office | "*T* is with the office for a final check, so I haven't started a new version. I've passed what you said to them; they'll follow up here." |
| approved, being sent | "*T* is already approved, so I haven't started a new version. I've passed what you said to the office; they'll follow up here." |
| delivered, not reopened | "I can't start a new version of *T* by myself, so I've passed what you said to the office; they'll follow up here." |
| with a designer | "A designer at the office is working on *T*, so I've passed what you said to them; they'll follow up here." |

Other changes:

- **Change kept while the design is being made.** The requester heard "I've added that to *T*", but the office heard the words were not applied. The requester now hears "I've kept that with *T* for the office". The office hears "It is not in the draft being made; add it in the next round or at review."
- **A delivered design that cannot be reopened.** This is a design made by hand, or one whose brief is missing. Its redo plan already held this update's receipt, so the kept note found no answer and returned `IDEMPOTENCY_CONFLICT`: the requester heard nothing. The note now gives its own answer, as it does after a replan, and a replay repeats it.

### 2.3 Status lines are true for their stage (L5)

- **Delivery already sent.** `activeChatRequests` reads whether Delivery's final notice for the current task reached the chat (`lc:dl-<task>-…:notice:send`). `spokenStage` calls such a `delivering` request delivered, in status answers and in kept-change answers.
- **Closed requests.** A status line is written only for stages it has words for. A closed request is not listed. After the parallel L1 fix, a cancelled request leaves the chat's request list.
- **Designs with the same name.** `distinctNames` adds when each design was asked for: "(asked for today at 08:44)" or "(asked for yesterday at 15:18)", in Iraq time. Two asked for within the same minute become "(version 1)" and "(version 2)". This applies to status answers and to "Which design is this for?" and "Which one should I redo?". The question's options carry `askedAt`.
- **Titles that name no design.** A title stored from words that name no design ("do a better design thats similar to earlier o…") is shown as "your design", as ADR-200 section 6.3 names new ones.

### 2.4 Titles (L6)

- **`requestTitle` (new, `request-title.ts`).** A deterministic title helper that also works as the fallback. `chat-campaign-intake.ts` calls it. It removes:
  - the greeting and the request around the subject (ADR-182);
  - the format-and-verb lead-in: "an Instagram post announcing our …", "a flyer promoting the …", "poster about …", "banner for our …".
  It keeps the capitalised name that follows ("Assessment Literacy Workshop"), else the first sentence. "Poster for the graduation ceremony" keeps its words. The client is named once, and there is no direction mark at either edge.
- **`requesterTitleName` and `trimTitleMarks` (`@hawa/integrations`).** They strip U+200E, U+200F, U+061C, U+202A–U+202E and U+2066–U+2069 at a title's edges and after "Client: ". RequestLifecycle's notices, the delivered caption and the delivery notice use them.
- **Not changed here.** The title that Core's delivery prepare sends (`omnichannel-delivery.ts`, Codex's file) is unchanged. It is cleaned where it is shown.
- **Grounded headline (ADR-232).** The third stream sets a headline grounded in the brief at open, in `lifecycle-projection.ts`. `requestTitle` is the fallback there too. The lead wires it at merge.

### 2.5 Office alerts (L7)

Every alert about a requester's words now:

- names them by the first and last name Telegram sent with the message (`requesterName`), else by their @username, else "A requester";
- names the design;
- says in plain sentences what happened and what to do;
- quotes their words exactly as sent;
- ends with one line, "Desk search: 030996c1", the short task id the Desk's search finds.

This covers the late-change and pending-change alert (`lateChangeOfficeAlert`), approval, timing and file notes, words about an old design, questions, conflicts, slow designs, unplaced SVG files, blocked changes and edits. The cancel line keeps its sentence. Only its subject changed from the chat id to the name.

### 2.6 The approval choice (L10)

- **Which drafts are listed.** The office queue (`officeQueue`) lists only drafts that can still be decided: the task has a current revision, and no approval of that revision stands (one not invalidated).
- **One approvable draft.** When approval words find exactly one, the bot confirms it by name: "Approve *T* and send it to you now?", or "Send *T* to *R* now?". This holds even for a member with designs of their own on the way, who was asked "which draft?" before. Nothing is sent unconfirmed.

### 2.7 Questions about what the office makes (L11)

`asksWhatTheOfficeMakes` reads "can you also make videos?", "do you design logos?", "could you print banners too?" and the Sorani "do you also make videos?" as questions for the office.

- It applies when the object names no design of theirs and asks for no change. "Can you make the title bigger?" and "can you do it again?" stay changes.
- A request for a design stays a new brief.
- The question goes to the office (`questionOfficeAlert`: "Nothing was changed and no design is held back"). The requester hears "I can't answer that myself, so I've passed your question to the office". Nothing is kept on a design, and Deliver is not held.

## 3. Cost

No new call. Redo targets, status lines, names, titles and question readings are deterministic. The office queue filter is one `NOT EXISTS` on `hawa.approvals` per office turn. The office reading is consulted exactly where it was before: an approval with one draft and a member's own designs on the way was a consulted "which draft?" and is now a consulted confirmation.

## 4. Verification

- **`apps/core/test/truthful-chat-replies.test.ts`, 33 tests.** They cover:
  - the live states and words for L2, L4, L5, L6, L7 and L11, as units;
  - the live sequences through Core's intake against the test database: the 13:05Z redo words with K-12 stuck in `delivering` and the accidental request beside it; the reply to message 678; a delivered design that cannot be reopened, with a replay; the status question with two K-12 designs, a sent delivery and a closed request; "can you also make videos?" while a draft is with the office.
- **`natural-language-stress.test.ts`.** Three new scripts in `fixtures/nl-scripts/truthful.ts`:
  - S161: redo words an hour after a request was opened for a designer;
  - S162: "can you also make videos?" while the draft is with the office;
  - S163: status with two designs of one name.
- **`office-telegram-approval.test.ts`.** One new test, the 14:03Z "looks good, send it": two approved K-12 drafts whose requests still read `in_review`, the owner's own request opened for a designer, and the Instagram post. The bot confirms the post by name, and "yes" sends only that one.
- **Red first.** With `apps/core/src`, `apps/worker/src` and `packages/integrations/src` at `b83c9f1d` (integrations dist rebuilt) these fail:
  - S161–S163, and the L10 test (it answered "Which draft do you mean?" with all three);
  - 24 of the 33 tests in the new file, run with stubs for the helpers that do not exist on the base. The 9 that pass are the "still about their design" readings, a brief that stays a brief, and the exact-quotation check.
- **Changed deliberately, each with its reason in the test:**
  - `lifecycle-internal-intake`, `requester-intent-routing` and `requester-intake-friction-adr156`: the "kept with … for the office" wording, and the Desk line in place of the full ids;
  - `redo-understanding` and S159: no "I'll redo" while a draft is with the office;
  - S004 and S107 in the stress fixtures: the new wording;
  - the stress harness recognises office alerts by the requester's name.
- **Also changed deliberately:**
  - `requester-revision-conflict-adr156`: the plainer conflict wording.
- **Found by the full run.** The first full run caught `shortTitle` naming one-word titles ("Report", "Nawroz") "your design". The rule now applies only to sentences of four words or more.
- **Full runs, typecheck and lint.** `apps/core`, `apps/worker` and `packages/integrations` together passed 333 files and 4,017 tests, with 3 files and 4 tests skipped. A Desk `vite build` was in place for CV-17. `pnpm typecheck` (655 test roots) and `pnpm lint` pass.

## 5. Limits

- **L10 in production is not verified.** No SQL is allowed against production, so the state of the two K-12 requests in the live list was not seen. The filter covers an approval standing on the current revision and a task with no revision. If those requests were in review with no approval, they are still listed, now with what tells them apart (ADR-040).
- **Kept changes are still not applied (L8).** A change kept while a design is being made is still not folded into the next round. The wording no longer says it was added.
- **Not tested live.** No live Telegram, no real model call, no native Sorani review. There are 12 new or changed Sorani lines in `SORANI_REVIEW.md`, marked ADR-231.
- **The owner's own wording.** `office.draftAlertDecide` and `office.lostTrack` still name a reply target (ADR-200 section 5).
