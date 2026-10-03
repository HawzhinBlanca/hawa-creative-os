# Conversation fuzz (2026-10-03)

- **Harness:** `apps/core/test/fixtures/conversation-fuzz.ts`, run as four shards, `conversation-fuzz.test.ts` and `conversation-fuzz-2/3/4.test.ts`. Seed 20261004, about 55 s.
- **Code under test:** `b56020bf` (live), then `claude/convfuzz` @ `4e19a572`.
- **Class tests:** `conversation-fuzz-classes.test.ts`, 31 route tests. 29 failed on b56020bf; the 2 controls passed.

## Method

320 conversations, 1166 requester turns. Each one runs through the worker's ChatInbox, Core's real intake route, TelegramSender and RequestLifecycle, on the test Postgres. No model, Canva or other paid provider is called; the run asserts this.

**Each conversation:**
- **Opens with a brief:** English, Sorani from the repo's tests, or Arabic.
- **Then has 1 to 4 follow-ups.** Families: change, negative or positive opinion, status, deadline, cancel (plus yes or no), thanks, small talk, a second brief, redo.
- **About 12% of follow-ups are reply-tos.**
- **The design moves through** designing, then office review, then delivered.

**Invariants:**
- **J1:** no round or request starts without an explicit brief or redo.
- **J2:** a cancel asks first, and only "yes" withdraws.
- **J3:** a change never opens a request and never loses its words.
- **J4:** replies are natural language, in the requester's language.
- **J5:** thanks and small talk do nothing.
- **J6:** a negative opinion is never thanked.
- **J7:** "passed on" means the office was alerted.

## Results

| | Before (b56020bf) | After |
|---|---:|---:|
| Total | 69 | 0 |
| J1 | 11 | 0 |
| J2 | 41 | 0 |
| J3 | 15 | 0 |
| J4 | 0 | 0 |
| J5 | 2 | 0 |
| J6 | 0 | 0 |
| J7 | 0 | 0 |
| Opinion asked "a change or a new design?" | 35 | 0 |
| "Nothing in progress" while a brief waits for "who is it for?" | 8 | 0 |

## Classes, ranked (all fixed)

1. **Named cancels withdrew at once (J2, 36).** "We don't need it anymore", "please cancel the poster", "cancel it", the Sorani forms, and "cancel both". Every cancel now asks "Do you want me to cancel X?". This supersedes ADR-251's named-cancel rule and ADR-255's immediate withdrawals.
2. **A change with nothing open opened a request named by the change (J1/J3, 8+8).** For example, "A designer will make make the text bold". The change now goes to the office.
3. **Arabic cancel words were asked "change or new?" (J2, 5).** They are now cancel words.
4. **"any update?" was read as "anyone" when answering "who is this design for?" (J1, 2).**
5. **A brief waiting for "who is it for?"** gave status "nothing in progress", and a cancel there got "nothing to cancel", after which the brief still opened at the timeout. Status now explains what it is waiting for; cancel asks first, and "yes" drops the brief.
6. **Refusal-only words while designing started a paid round (J1, 1).** They now go to the office.
7. **"less text please" was dropped (J3, 7).** "less/fewer/more <part>" and "lose the subtitle" are now changes.
8. **Small talk and opinions (J5 2, friction 35).**
   - "have a nice day" is now treated as thanks.
   - Vague unhappy words become an unhappy reaction: the office is alerted and the requester is asked what to change.
   - Single-clause praise is thanks.

## Not fixed

- A change sent while a brief waits goes to the office with a "no longer open" alert.
- A deadline sent while a brief waits gets the waiting question back, and its words are not passed on.
- A bare organisation name with nothing open opens a request for a designer.
- "the logo looks squashed" is still asked "change or new?".
- The Arabic phrases need native review.
