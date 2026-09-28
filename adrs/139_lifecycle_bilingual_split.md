# ADR-139: An English-and-Kurdish Brief Opens One Lifecycle Request Per Language

**Date:** 2026-09-29
**Status:** Implemented and locally qualified; not deployed.
**Requirements:** FR-001, FR-004, FR-060.
**Changes a foundation:** ADR-059 (one Telegram update opens at most one lifecycle request): a bilingual brief of the shape below opens two.
**Builds on:** ADR-135 (every Telegram request takes the lifecycle path), ADR-034 (RequestLifecycle), the legacy split `splitBilingualRequest` (`apps/core/src/services/chat-intake.ts`, 2026-09-19).

## 1. Context

On 2026-09-19 (task 89c242f2) the owner sent one brief with English copy for one graphic and Kurdish copy for another: instructions, a line such as "Here is the text to add on each of the Kurdish and English graphics:", the English copy, a divider, the Kurdish copy. Intake took the English copy for instructions and one Kurdish design was made. Legacy intake was fixed to make one task per language (`splitBilingualRequest`, `telegram-webhook.routes.ts`), each designed, approved and delivered on its own.

Since ADR-135 every Telegram brief opens a RequestLifecycle request instead, and the lifecycle open had no split: the same brief opened one request whose copy was the Kurdish only, the 2026-09-19 bug again (ADR-135 section 3). Nothing in ADR-034, ADR-059 or ADR-135 chose that; ADR-135 recorded it as a gap, and the retirement plan requires the split to be ported before the legacy new-request stage is deleted (`LEGACY_PATH_RETIREMENT.md`, stage 2c).

## 2. Decision

- **The same split, on the lifecycle open.** When Core's internal intake would open a request for an ordinary new brief (not instruction-only) and `splitBilingualRequest` recognises it, it prepares one draft per language: the English one under the request ID it always used (`telegram-new-brief:<chat>:<update>`), the Kurdish one under `…:<update>:ckb`. Each draft reads exactly as legacy intake's did (the instructions, a note that this graphic carries one language only, the divider, that language's copy) and carries `hawaLanguageGraphic` in its source JSON. A photo or confirmed album sent with the brief is retained once and belongs to both drafts. Anything else, including one bilingual graphic with both languages, stays one request.
- **One decision, replayed whole.** Both drafts are recorded in the update's one new-brief decision (`lifecycle_chat_open`, the second as a sibling), and the answer names both (`siblings`). A replay answers the same two. Projection accepts a sibling draft only if that decision recorded it for that request ID, as it already required for the first (images, albums).
- **Each request is its own.** ChatInbox opens every request the answer names, each with its own keyed `RequestLifecycle.open` (`open:<requestId>`), so each has its own task, acknowledgement, draft, office review, approval and delivery, as the legacy tasks did. A reply that links neither request's notice is refused as ambiguous while both wait for the requester, as for any two waiting requests.
- **No worker is asked to do what it cannot.** The worker says it opens every request an answer names (`languageSiblings: true` on its intake call). Core splits only for such a worker; for a worker of an earlier release (a colour still draining during a deploy, or a rollback) it opens one request, as before. A decision already recorded with a sibling is never replayed to such a worker (`503 LANGUAGE_SIBLINGS_UNSUPPORTED`, retried and then parked for an operator) rather than silently opening one language.

No migration: the decision is an existing `inbox_events` row with one more field.

## 3. Consequences

- The requester gets two acknowledgements and two drafts, as with legacy intake; the office reviews, approves and delivers each.
- Each request counts against the daily limits and spending allowance on its own.
- FR-004 ("no more than one task" per source event) reads, for this brief shape only, as one task per language, as it did on legacy intake: the one recorded decision names both, and a repeated event makes neither again.
- Replies to one of the two waiting requests must be Telegram replies to that request's notice.

## 4. Verification

- `apps/core/test/lifecycle-bilingual-open.test.ts` (internal intake and projection routes, isolated database): the owner's message of 2026-09-19 opens two requests, each projected to a Restate-owned task with only its language's copy and the shared instructions; the replay answers the same two; an older worker gets one request; a two-language decision is not replayed to an older worker; single-language and single bilingual-graphic briefs stay one request; a photo belongs to both drafts, each projected against the one decision, and a draft the decision did not record for that ID is refused. Red first: 3 of 5 failed on the unchanged Core (the two "stays one request" cases passed).
- `apps/worker/test/chat-inbox.test.ts`: ChatInbox opens both requests under their own keys, none twice across a crash; the core client sends `languageSiblings` and refuses a malformed sibling.
- Chaos `R1.BL`: a bilingual brief through the whole stack opens two lifecycle requests; each is drafted, approved and delivered once, with one planner call each. Results: `plans/lean-design-implementation-2026-09-28/RECONCILIATION_PROOF.json`.
