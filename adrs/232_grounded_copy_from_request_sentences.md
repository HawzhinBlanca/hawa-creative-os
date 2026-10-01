# ADR 232 — Copy taken from a request sentence, grounded in the requester's own words

Date: 2026-10-01. Status: accepted for review on branch `claude/nl-copy-extraction` (base `b83c9f1d`, production). Not deployed, not live-tested.

## Problem (live test L9, P0)

Request ab48fb97 / task 58b2d90f: "Can you make an Instagram post announcing our Assessment Literacy Workshop for school principals? It's on 15 October 2026 at 10:00 AM in the KAAE hall, Erbil. Registration is free." Intake (`chat-campaign-intake.ts`) separates instructions only when they stand on a line or paragraph of their own, so this one-line message became the design's only copy block. The studio prints `exactCopy` exactly: every candidate showed the whole sentence in one paragraph, with no headline, and the copy check passed because the expected copy was that sentence. The task was titled "KAAE: Instagram post announcing our Assessment Lite…". Requesters only speak naturally (owner rule), so every such request did this. The lines named in the report (`lifecycle-projection.ts` `copyEn: rawText`) belong to the reviewed voice/PDF path, whose copy the requester confirms as "exactly the text for the design"; that path is unchanged.

## Decision

`apps/core/src/services/request-copy-extraction.ts`, applied to the prepared draft at intake (`lifecycle-internal.routes.ts`, `openBrief`) before the new-brief decision is recorded. The lifecycle open (`projectLifecycleOpen`) persists that recorded draft; revision rounds inherit the parent's `exactCopy` and headline fields (no copy is re-derived from a change), so a round neither re-reads nor pays.

1. **Only a request sentence is touched.** The draft's copy must open with request words: an ask ("can you make", "please design", "I need", "we'd like", Sorani تکایە / دەمانەوێت / دروست بکە …) followed by a design noun, or a platform job ("Instagram post announcing …"). Copy the requester laid out (lines, paragraphs, "Here is the text:", dividers), a design noun used as copy ("Design for Change conference"), a request without copy, and a reviewed voice/PDF source are returned unchanged, with no model call.
2. **Quoted words** inside a request sentence are the copy, as given (no model call).
3. **One model reading** otherwise: `resolveModel('text')` through the intake router's `readOnce` (reader `copy`, ADR-144/200 ledger `hawa.requester_intent_calls`, row key update id + 2^51, office rows stay at + 2^52). No call without an OpenAI key, without the client's consent (egress policy and active DNA), without a client, beyond the shared allowance (role `intake_router`), above a $0.05 reservation, for more than 1,500 characters, or for a brief split into several deliverables. A replay uses the stored answer; an uncertain first call is never repeated. Its answer is data.
4. **Grounding guard, in code.** Each proposed line is rebuilt from the requester's text: one span, or up to four spans in their order joined by " · ", at word boundaries, where only glue words (it's, on, at, in, the, our, and, Sorani لە، بۆ، و …) may be left out between spans; no span may touch the request words or a sentence to the designer (photos, colours, thanks). Matching ignores case but the output is the source's characters, so casing, digits, dates, times and names are exactly as typed ("Keep exactly as typed"; a model's "For School Principals" prints as "for school principals"). A refused line is dropped and recorded; a refused headline sends the request to rule 5.
5. **Rules fallback** (no model, a refusal, a failure): the request words at the start are removed, the rest is taken sentence by sentence, sentences to the designer are left out, leading glue ("It's on") and a closing Sorani verb are dropped, and the result passes the same guard. The raw sentence with its instruction is never the copy.
6. **Nothing safe left**: the request opens for a designer as a request without copy does (`isInstructionOnly`, no automatic draft, empty `exactCopy`), with the words as instructions.

The extracted draft carries `exactCopy` (headline, then body lines, each with its own script and direction), `headlineEn`/`headlineCkb` and `copyEn`/`copyCkb` by script, the title "<Client>: <headline>" (no second client prefix, no ellipsis unless the headline exceeds 60 characters), the original words appended to `designInstructions`, and the receipt `copyExtraction` (method, plain-words reason, request words, headline, lines, refused lines, ledger row). `persistChatIntake` writes the receipt to the task's creation event; the Desk shows copy as before.

## Cost

Rules, quotes and laid-out copy cost $0. A reading is one Sol call (`gpt-6.1-sol`, `max_completion_tokens` 600, low reasoning). The live request's body is 1,677 bytes; `reserveStudioText` reserves **$0.0195** (3,009 input, 600 output tokens; at most $0.031 at the 1,500-character limit). Priced by `studioTextUsage`, a typical reading (about 560 input, 90 to 300 output tokens) costs **$0.003 to $0.006**. At most one reading per new request; none per revision round or replay. Not measured against the live provider.

## Verification

`apps/core/test/request-copy-extraction.test.ts` (23 tests): the live sentence with the model mocked (headline "Assessment Literacy Workshop"; lines "for school principals", "15 October 2026 · 10:00 AM", "KAAE hall, Erbil", "Registration is free"); the guard refusing invented, reworded, reformatted, re-ordered, partial-word and request lines; glue-only gaps; explicit, quoted, laid-out and reviewed copy unchanged with no call; no consent / no key / mock key / zero allowance → rules, no fetch, no ledger row; Sorani and mixed English/Sorani; nothing safe → manual; the paid ledger (one row, reader `copy`, cost recorded, replay without a second call); and through intake → projection → a revision round (receipt on the creation event, the round inherits the copy, the model is read once). With the intake wiring reverted the two route tests fail (the draft's only copy block is the sentence). apps/core 2,735 passed (4 skipped), apps/worker 369 passed; `pnpm typecheck` and `pnpm lint` pass.

## Open

Native review of the Sorani request and glue words. The Desk does not yet display the receipt (Codex owns `apps/desk/**`). A voice or PDF transcript that the requester confirms is still printed as confirmed. Relevant requirements: FR-013, FR-014, FR-015.
