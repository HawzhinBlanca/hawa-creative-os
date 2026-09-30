# ADR-148 — GPT-6.1 Sol candidate; Jev visual judge rejection

Date: 2026-09-30
Status: Accepted for candidate implementation; production promotion blocked
Requirements: FR-056, FR-057, FR-058, FR-059, FR-060, FR-062

## Decision and evidence

The owner requests GPT-6.1 Sol for design roles and Jev instead of GPT-4.1 Mini
if it can do the same work, and explicitly permits reuse of the existing OpenAI key.
Prepare the exact `gpt-6.1-sol` candidate on the development/evaluation tier.
Keep Astra production defaults and the independently measured Mini visual judge
until access, offline comparison and canary admission pass. No automatic fallback
or model-name substitution is authorized by this change.

The authenticated OpenAI model list returned 200 with Astra, but no Sol 6.1;
retrieving Sol 6.1 returned 404 while Astra returned 200. Access is not established.
The [official Sol card](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
documents image input, strict structured output and Chat Completions without tools.
Use explicit low reasoning to preserve the current effective effort, omit temperature,
and retain the existing bounded transport, receipts and uncertainty handling.
Standard token rates per million: input 2, cached read 0.10, cache write 2.50,
output 10; above 272,000 input tokens, the full request uses 2x input/cache and
1.5x output rates. The 128,000 output limit and 1,050,000 context limit apply.

The [vision sizing guide](https://developers.openai.com/api/docs/guides/images-vision)
read today does not name Sol 6.1's image token multiplier or sizing bounds.
Do not borrow Astra's policy as proof. Candidate text reservations are implemented;
image reservations fail closed until Sol's specific bound is qualified. Existing
reservation policy identities remain unchanged so old retained stages still replay.
Sol has its own policy identity. Neither preparation nor a synthetic API smoke
constitutes creative-quality admission.

TypeSafe's [official catalog](https://docs.typesafe.ai/models) lists `jev-1.13.0`
as the current stable release and preview target. It is text only, with no image,
audio or video input. The visual judge and parity calls require actual images:
Jev cannot do the same work. Describing images with another model would add cost,
latency and an information bottleneck. Do not integrate that substitute or request
a Jev key for an ineligible role. Its English-first language performance and
[documented failure modes](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
also require separate evaluation before any future text role is proposed.

## Admission path

1. Establish access with this project's existing key; the probe emits safe metadata only.
2. Qualify Sol-specific image sizing/reservation and strict schema plus images in one call.
3. Freeze matched briefs, assets, copy, fonts, prompts and reasoning profiles; compare
   Astra/Sol using existing evaluation harnesses, with native Sorani and blinded human review.
4. Record actual served models, usage, cost and latency distributions; no critical QA escapes,
   exact-copy loss or regression. Confirm retained-stage model/binding changes hold safely.
5. Admit a human-reviewed 5% canary, then 25%, then primary through a new measured decision.
   Keep an evaluated explicit rollback. Never send an old run silently to a new model.

## Verification

Focused tests cover candidate-only allowlisting, reasoning and temperature payloads,
exact standard/cache/long-context prices, text budget reservation, model identity,
unqualified image refusal and retained-stage identity drift. Evidence and unexecuted
live/creative gates are recorded in `plans/model-migration-2026-09-30/`.

## Local verification result

262 unique tests pass across the focused and PostgreSQL regression suites; the
final candidate rerun passes6/6 and final intake rerun62/62. Production and script
types,603 test roots and lint pass. Original stale-build failures remain in the
evidence directory. Full release suite and live Sol/creative/canary gates are not
executed; this is not a production admission. Fresh runtime metadata still reports
deployed6bd479c1, Astra text/layout/critique and Mini judge; readiness is degraded.
