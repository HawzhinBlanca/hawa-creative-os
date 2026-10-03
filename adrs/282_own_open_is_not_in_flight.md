# ADR282 — An update's own open is not a request "still opening"

Date: 2026-10-03. Status: selected; qualified locally.
Requirements: FR-004 (docs/09_MESSAGING_AND_OFFICE_INBOX.md), FR-060 (docs/10_WORKFLOW_RELIABILITY.md).
Amends ADR-143 (album settle) and the F4 "open still in flight" rule of ADR-144 intake. Follows ADR-281
decision 7, which made the once-seen race failure name itself.

## Finding

CI run 37078578560 failed once in `lifecycle-album-settle` ("never starts twice when the settle, a brief
and /use_album race"): one of four racing answers was neither the opened request, a skipped settle nor
an album message. The cause is in Core intake, not in the test's timing.

Two calls of one update (here, the album's settle sent twice) both read the update's prior decisions
(`readNewBriefDecision`, `readIntentReceipt`, apps/core/src/routes/lifecycle-internal.routes.ts, the
"A decision must replay" block) before either stored one. The first then records its intent receipt and
its open (`lifecycle_chat_open`, keyed by the update ID). The second, still running, reaches the F4 check
a few statements later, `openingChatRequests` (apps/core/src/services/requester-turn-store.ts), which
lists every open in the chat that RequestLifecycle has not projected yet, and finds its own update's open
there. A new brief is not an acknowledgement, so it answers `intakeStatus 503 REQUEST_OPENING`: "wait for
the request you are a follow-up to", where that request is the one this very update opens.

Reproduced deterministically by holding the second call at that read until the first has answered
(new test "ADR-282: a settle delivered twice at once…"): before this decision it answers
`[503, REQUEST_OPENING]`; a jittered run of the original four-way race failed in about half of 80
iterations, every time with that one answer, and every time with exactly one request and one open.

## Effect on requesters

None seen and none possible beyond a delay. ChatInbox runs one call per chat at a time, so two calls of
one update overlap only when a worker re-runs a step while Core still answers the first (a worker
restart, or an answer later than the 480 s client timeout). The 503 is a retryable answer: nothing is
sent, ChatInbox tries again after 2 s and then replays the stored open. No request is duplicated, no
photo is lost and the requester is told nothing wrong. A handleUpdate retry spends one of its five
attempts.

## Decision

`openingChatRequests` takes the update being read and leaves out the open decided for that update (its
`source_event_id`, siblings included). An update is never a follow-up to the request it opens. The
second call then goes on to the same keyed open (`recordNewBriefDecision`, `ON CONFLICT DO NOTHING`,
the request ID derived from chat and update), which returns the first call's stored decision. Both
answers name the one request. That is the convergence the race test already expected ("racing answers
may each say duplicate=false for the one stored decision").

Opens decided for any other update of the chat still make a follow-up wait, as before. No schema,
migration, dependency, model call, worker change or new answer.

## Evidence

- `apps/core/test/lifecycle-album-settle.test.ts`: the barrier test fails before the change
  (`[503, undefined, "REQUEST_OPENING"]`) and passes after it. One request, one open, one task. The four-way
  race test is unchanged.
- `apps/core/test/requester-intent-routing.test.ts` and `natural-media-intake.test.ts` still prove that
  a follow-up from a different update waits with `REQUEST_OPENING`.
