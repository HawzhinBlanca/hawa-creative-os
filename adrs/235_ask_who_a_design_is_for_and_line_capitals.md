# ADR 235 — Ask who a design is for; capital first letters on extracted lines

Date: 2026-10-01. Status: accepted (owner decisions of 2026-10-01) on branch `claude/ask-client-and-line-case`, base `53644d3b` (production). Not deployed, not live-tested.

## 1. "Ask who it's for"

**Before.** A fresh brief from a chat bound to no organisation, whose words name none, opened silently for a designer (Invariant #4: never guess). Live, from the owner's chat: "Could you design a poster for our Teacher Appreciation Day? …" → "Got it. A designer will make Teacher Appreciation Day…" (L14).

**Decision** (`apps/core/src/services/lifecycle-client-question.ts`, wired in `openBrief` and before the turn is planned in `lifecycle-internal.routes.ts`):

- Such a brief is **kept** with its words and photo (a captioned photo is retained when the question is asked), and its sender is asked in words: "Who is this design for? Tell me the organisation's name." Only a brief that would have been designed automatically is kept. A brief without copy, a brief split into several designs, an album, a burst photo, and a brief whose words or chat name a client all open as before. Paid calls: none before the answer, and the copy reading (ADR-232) is made only once the organisation is known.
- **Privacy.** The organisations are listed ("The ones I know: …", active clients with their short code, at most twelve) only in an office member's own private chat. Every other chat gets only the open question.
- **The answer** is read with intake's client matching (`resolveSourceClient`: chat binding, packs and their Sorani phrases, client names and codes). A message answers the question when it replies to it, says "I don't know" / "not sure" / "just make it" (English or Sorani), or is a short answer (six words or fewer, not a question or a change) that names one organisation and no design or date. Then:
  - one organisation → the kept brief opens for it exactly as if it had been named (automatic design if allowed, ADR-232 copy, title);
  - "not sure", or a reply that names none the office works with → it opens for the office to choose, and the sender is told so;
  - anything else is read as any message is: a new brief opens or is asked about in turn, and the newest question takes the next answer. "Could you design a KAAE poster for our Book Fair? …" is a brief of its own, not the answer.
- **Pending-choice rules (ADR-040).** A question carries `askRules` (`CLIENT_QUESTION_RULES` = 1) and `askedAt`. An answer after 30 minutes, or to an older stamp, opens the kept brief for the office and says "It's been a while since I asked…": the words are never lost and never guessed for. A question older than a day is no longer read.
- **Once and replay-safe.** The question (`lifecycle_client_question`) and its answer (`lifecycle_client_resolution`) are inbox-ledger rows under the brief's update (first write wins). The kept brief opens under the answering update through the usual new-brief decision, so a replay of the answer replays the open. A replay of the brief asks the same question and opens nothing, and a second answer finds the question closed.
- **Wording.** English and Sorani in `packages/integrations/src/requester-messages/client-question.ts` (`clientQuestion.*`), answered in the language of the answer; the Sorani lines are listed in SORANI_REVIEW.md for native review. Natural language only.

- **Nothing is dropped (ADR-144): the timeout.** Core's question carries `clientQuestionSettle: { delayMs: 1,800,000 }`. ChatInbox then schedules a durable delayed settle of the brief's update under its own key (`settle:<update>:client-question`; ADR-143's mechanism, no new infrastructure).
  - **Backup.** If that call is lost, the poller's settle sweep (`/v1/internal/telegram/settle-sweep`, every five minutes) lists every question unanswered after 30 minutes, with the brief's stored update.
  - **The settle** (`clientQuestionTimeout`):
    - not yet due → nothing;
    - already answered → nothing;
    - due → it writes the resolution `timeout` under the brief's own update and reads the kept brief again. It opens for the office to choose, exactly as "not sure" does.
  - **Told once.** The sender hears once: "I haven't heard who this design is for, so I've passed it to the office; they'll pick the organisation." The notice goes under its own key (`client-question:<update>`), so a replay of the settle or a sweep's second send says nothing again.
  - **The race.** The answer and the timeout both write the same resolution row; the first write decides, and the other opens nothing.
  - **A later answer.** An answer after the timeout that names an organisation (a reply, or a short answer) opens nothing again. The sender hears "Thanks. I've told the office that <design> is for <organisation>.", and the office is told to assign it in the Desk.
  - **Worker changes** (`chat-inbox.ts`, `core-client.ts`): the timeout settle is scheduled, and the keyed notice is sent under its own key.

**Open.** Albums and multi-design briefs still open for the office when no client is named. A group chat asks the sender in the group. A photo sent before the brief, and still waiting for words, is not taken by a timeout's open (an answer's open takes it).

## 2. "Capitalize first letters"

Each line ADR-232 takes from a request sentence, by the model or by the rules, headline included, starts with a capital when its first character is a lower-case Latin letter ("for school principals" → "For school principals"). Nothing else changes: the rest keeps the requester's casing (no title case), and Sorani or Arabic script, digits, quoted copy and copy the requester laid out are never touched. The grounding guard is unchanged and accepts the line: it compares without case and rebuilds every line from the requester's own characters before the first letter is raised, so that letter is the only character not exactly as typed. The receipt lists the lines changed (`copyExtraction.capitalised`, as typed). See the ADR-232 addendum.

## Verification

`apps/core/test/client-question-and-line-capitals.test.ts` (9 tests):
- the live Teacher sentence from the owner's chat (asked with the names, "KAAE" opens it for KAAE once, replays) and from an outsider's chat (no names);
- a Sorani answer as a reply;
- "not sure", Sorani "I don't know" and an unknown organisation (office, told so);
- expiry, and a new brief sent instead;
- the capital rule, its receipt and the guard; quoted and laid-out copy unchanged.

All 9 fail on `53644d3b`. The quoted/laid-out case is a control that fails there only because `capitalFirst` does not exist yet; the six intake tests fail against the old routes alone.

Existing tests that encoded the silent open or the lower-case lines were updated:
- briefs in fixtures now name KAAE where the test was not about the client (album caption limit, ADR-156 #10/#11, S149, S157);
- S024 names ZAR Podcast (Nova is not a client in the database);
- S025 now expects the question and "not sure";
- the friction audit's F2 accepts the question;
- ADR-232 copy tests expect "For school principals" and "Staff football tournament".

Timeout (follow-up), 3 Core tests and 1 worker test, all failing before:
- unanswered: the settle opens the brief once for the office and announces it once under its key; replays and the sweep open nothing more; early settles and sweeps do nothing;
- an answer just before the timeout wins, and the settle then opens nothing;
- an answer after the timeout names the organisation for the office and opens nothing;
- worker: the timeout settle is scheduled once under its key, an out-of-range delay is refused, and the timeout's notice goes under its own key.

apps/core, apps/worker and packages/integrations: 4,176 passed, 4 skipped. `pnpm typecheck` and `pnpm lint` pass.
