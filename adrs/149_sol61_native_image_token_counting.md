# ADR-149 — Sol candidate image reservations use native input counts

Date: 2026-09-30
Status: Accepted for candidate implementation; production admission pending
Requirements: FR-056, FR-057, FR-059, FR-060, FR-062, FR-079

## Evidence and decision

The owner enabled Sol access: the existing key now lists and retrieves
`gpt-6.1-sol` with200. Preserve the original404 observation separately.
The [official token-counting API](https://developers.openai.com/api/docs/guides/token-counting)
accepts actual images and reports their model-specific input token count. Actual
synthetic64×64 and1080×1350 queries returned200, object `response.input_tokens`,
18 and1768 tokens respectively. This is capability evidence, not creative admission.

For Sol candidate calls carrying images, count their exact inline data first through
`POST /v1/responses/input_tokens`, then reserve the serialized Chat Completions body.
Count all image parts in one user input, with their original detail, without changing
the actual completion messages. Require inline images so a remote resource cannot
change between counting and completion. The native count includes framing; add the
existing independent UTF-8/schema/message bound to it rather than assume Responses
and Chat Completions framing is identical. This deliberately overbounds text/schema
while avoiding an invented Sol image multiplier. The model's actual accepted usage
must remain below its reservation; overruns hold as before.

Bind the count to the exact completion body SHA256 and requested model. Retain the
safe count metadata inside the paid-call reservation JSON; it contains no image/prompt/key.
Unknown, malformed, failed or mismatched counts refuse completion dispatch. Counting
does not generate an answer and cannot authorize a task action. No tools, continuations
or speculative fallback are introduced. The paid request still uses the existing
transport, schema validation, budget gate and uncertainty/replay rules.

Sol counted-image reservations have their own v2 identity. Sol text-only reservations
keep their v1 identity, and every previous model retains its previous policy identity.
Production stays on Astra and Mini until FR-057 offline, native human and canary gates.

Core reuses a retained count only for the identical serialized request hash. The
existing semantic replay and authority checks still decide whether the saved answer
may be consumed. Invalid retained metadata holds before counting or completion;
recovery of a valid retained Sol response needs no provider transport.

## Verification scope

Tests must cover count binding, inline-image/detail preservation, invalid/failed
counts, refusal before completion, immutable completion bytes and budget/usage bounds.
A bounded synthetic image+strict-schema smoke records actual served identity, usage,
cost and latency. It cannot replace the matched office corpus or blinded review.
