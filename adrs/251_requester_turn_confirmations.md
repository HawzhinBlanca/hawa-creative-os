# ADR-251: Short Requester Words Confirm Before They End, Pause or Choose

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/hunt2-turn` (from production `1e0616f0`); not deployed.
**Requirements:** FR-005 (requester messages), natural-language-only rule (owner, 2026-09-29).
**Changes a foundation:** no. No migration, no new dependency, no new paid call, no new phrase.
**Builds on:**
- ADR-144: one planned action per requester message (`requester-turn.ts`).
- ADR-145: requester phrases in English and Sorani.
- ADR-230 and its addendum (L12, L17): a requester's cancel withdraws a request; uncertain cancels are asked about.

**Number:** 251, assigned by the lead.

## 1. Context

Bug hunt 2 (2026-10-02) read the requester planner and found four kinds of friction:

- **Friction 1 (P0).** `CANCEL_EN` let the object be left out. So "never mind", "ok never mind", "stop", "no need" and "no, stop" withdrew the chat's only design, with no question asked. "Never mind" often refers only to the last thing said.
- **Friction 2 (P1).** The bot asks "Is this a change to X, or a new design?". Any answer that started with "no" counted as "new", so "no, it's a change", "no, the old one" and "no it's for Nawroz" opened a new request.
- **Friction 10 (P2).** A bare "wait", "hold on" or "hang on" paused the design. People say these just before they type more.
- **Friction 11 (P2, planner part).** A message with no letters (an emoji, a number) was always answered in English. A design with no name of its own was called "your design" in English, even inside a Sorani sentence.

## 2. Decision

1. **A cancel that names nothing is asked about first.** A cancel is bare (`bareCancel`) when no clause names a whole-request object, a description, or "it" as the subject ("it's not needed").
   - English examples: "never mind", "stop", "no need", "not needed", "cancel".
   - Sorani: "stop" and "no need".
   - A bare cancel never withdraws a design. It asks the existing question, "Do you want me to cancel X?", even when it is a reply to the design's own message.
   - "Yes" to that question withdraws the design, as before.
   - "No", "no, keep it", "don't cancel it" or "continue" leave the design alone, and the requester is told where it stands (the status reply).
   - A cancel that names its design ("cancel it", "cancel the poster", "never mind, cancel it", "we don't need it anymore") still withdraws the only design, as ADR-230 tested.
2. **Only a bare "no" chooses a new design.** This applies to "no", "nope", "no thanks" and the Sorani "no". When "no" leads other words, the planner reads the rest:
   - "it's a change", "the old one" or "the same one" mean the design asked about;
   - "new" or "a new one" mean a new design;
   - a reply that names the asked design means that design.
   - "No, it's for Nawroz" about another design means a new design. Its words go under the brief. If another design in the chat has that name, the bot asks about that design instead.
   - To a question that offers no new design, such as "Do you want me to cancel …?", a leading "no" never selects the design.
3. **A bare "wait" pauses nothing.** "Wait", "hold on", "hang on" and "one moment" count as an acknowledgement. "Wait, don't make it yet" and "put the poster on hold" still pause the design. A bare Sorani "stop" is no longer a pause: it is a bare cancel and is asked about.
4. **Sorani writers hear Sorani.**
   - `langOf(text, fallback)` answers a message with no letters in `fallback` (`hasLetters` tells the caller when that applies).
   - A design with no name is the catalogue's `yourDesign` in the requester's language, in every planner phrase (status, thanks, asks, notes, tells, redo).

## 3. Consequences

- A bare cancel now takes two messages instead of one. The question already existed (`WITHDRAW_MESSAGES.askCancel`), and "yes" goes through the existing confirm path (`resolves`).
- Two existing tests encoded the old behaviour and were changed:
  - `requester-turn-adr182.test.ts`: "wait" and the Sorani "stop" held the design;
  - `natural-language-stress` scripts S081 and S084: "no need anymore, thanks" and "stop" withdrew it.
- The intake route still calls `langOf(text)` with no fallback. Until it passes the chat's language (`mediaRoute.langFor`) when `hasLetters(text)` is false, emoji-only messages are still answered in English. That route belongs to another change.

## 4. Verification

`apps/core/test/requester-turn-confirmations.test.ts` uses the phrases from the findings. It failed first (36 of 57) and passes now. The requester and lifecycle conversation suites pass.
