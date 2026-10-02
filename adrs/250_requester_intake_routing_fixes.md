# ADR-250: Words That Edit a Design on the Way Are a Change; Intake Answers What It Cannot Start

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/hunt2-intake` (from production `1e0616f0`); not deployed.
**Requirements:** FR-004 (one logical decision per message, no duplicate task), FR-005 (requester messages), FR-079 (budgets and generation caps).
**Changes a foundation:** no. No migration, no new dependency, no new paid call.
**Builds on:**
- ADR-143/145: briefs held for photos; captionless photos kept for their sender's words.
- ADR-144: a message is read once, in the context of the chat's requests.
- ADR-230: a change to a design with the office is kept for the office; a cancel withdraws.
- ADR-139/186: one message, several deliverables.

**Number:** 250, assigned by the lead (bug hunt 2, items L19 and frictions 3, 4, 6).

## 1. Context

Bug hunt 2 (`HUNT2_FINDINGS.md`, 2026-10-02) found, live and by reading:

- **L19 (P1, live).** In the owner's chat (the owner is both a requester and an office member), "can you take KAAE's out of the title? just Quality Assurance Workshop" was sent while the KAAE poster waited for office approval. Intake answered `settle-later` (kind `brief`), then `open-request`: a second request and a second paid round.
  - Root cause: `readIntentByRules` read the words as a substantial new brief. They name an event ("Workshop") in eight or more words. `readsAsChange` does not know "take … out", and the heuristics call the words a brief.
  - `planTurn` then opens any substantial brief. The one exception is a brief that repeats a design *waiting for the requester's changes*, and a design `in_review` is not one.
  - The double role played no part: the office turn passed the words on. ChatInbox's stale request pointer played no part either: intake reads the chat's requests and treats the pointer only as a hint.
- **Friction 3.** A captionless photo, then a change kept for the office (design being made, with a designer, with the office): the photo was dropped. Only the brief and the round paths claimed held photos, so a later unrelated brief could take it.
- **Friction 4.** A brief for more designs than one request holds (8), or for a size outside 640–2400 px, answered a bare 422. The worker sends nothing for that: no reply, no office alert. The unsent text was English only and told the requester to "Send groups of…".
- **Friction 6.** Cancel words the rules cannot place are read by the intake router. The router has no "cancel": it read them as a change (kept for the office) or as chatter (the new-design greeting).

## 2. Decision

1. **Edits of a design on the way** (`apps/core/src/services/brief-or-change.ts`, called by intake after `planTurn`). The rules may read words as a non-explicit new brief, and `planTurn` may open them (or ask about them). In that case, when the chat has a design on the way (designing … delivering):
   - Words that name a part of that design and undo or replace it are a **change**. Examples: "take … out of the title", "remove", "without", "should be". The change is planned by `planTurn`'s own change rules: kept for the office (ADR-230), or a round on a design that waits for changes. If the words also name a different event, the requester is asked instead.
   - Words that only arrange a part, or that repeat the design's own name, may be either. The requester is asked "a change to X, or a new design?", and the intake router reads that as before. Generic event words and dates do not count as a name.
   - Words that carry their own copy (an event with a date or time) are left to open, unless they repeat a current design's name. A request for a design ("Can you make a poster…"), "/new", media, and a chat with nothing on the way are untouched.
2. **A photo sent just before a change goes with it** (the note branch). A design that can still use it takes the photo as material. Otherwise it is passed to the office with the words. Either way it is claimed once, and the requester hears where it went.
3. **A brief the bot cannot start is answered.** It gets a `chat-answer` in the requester's language (new catalogue section `intakeLimits`, both languages, listed in `SORANI_REVIEW.md`), and the office gets the words. Nothing is opened. The status stays 422 with the same codes. No instruction to regroup or to choose a size.
4. **Cancel words keep their meaning through the router.** The router may only say which design the cancel is about. The requester is then asked about that one by name. A change or chatter reading leaves the cancel question as the rules planned it, and nothing is withdrawn unasked.

## 3. Consequences

- The live L19 words now produce the late change on the request in review. Replays and the settle open nothing.
- A genuinely new brief (a new event with its date and venue) still opens while another draft waits for the office.
- Some short briefs that both arrange "the logo" or "it" and name no date may now be asked about, where before they opened at once.
- **Not done here (owned by other files).** `readsAsChange` in `requester-turn.ts` should also know "take/leave/get … out/off", "drop", "delete", "get rid of" and "should just be". The intake-side guard covers the routing either way.

## 4. Verification

- `apps/core/test/requester-intake-routing-adr250.test.ts`: 16 tests.
  - Before the fix, run against the production route: 14 failed and 2 passed (the legit-brief and the pure-unit cases).
  - After the fix: 16 passed.
- The related suites (intent routing, withdraw, natural media, ADR-156 friction, explicit deliverables, the requester catalogue) pass. See the commit message for the counts.

## Addendum (2026-10-02, live retest on the canary chat)

After deploy 92b14abf, the canary chat had a design with a designer. "can you take Spring out of the title? just Concert" no longer opened a request, but it asked "change or new design?". The words remove a named part of the design, so the requester rules (`readsAsChange`) now read them as a change.

What counts:
- removal wording: "take/leave/get … out/off", "get rid of", "drop", "delete", "erase", "remove";
- together with a part of a design: title, subtitle, date, logo, line, border, photo and the like.

`brief-or-change.ts` stays as the safety net for wordings the rules miss. Test: `apps/core/test/requester-turn-change-verbs.test.ts`.
