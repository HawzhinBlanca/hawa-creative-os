# ADR-091 — Reserve Studio spending before provider dispatch

Date: 2026-09-27
Status: Accepted for implementation; qualification recorded separately
Requirements: FR-059, FR-060, FR-062, FR-065, FR-079, NFR-001

## Context

ADR-088 stops calls after recorded cost reaches a limit. Concurrent calls can
all pass that check and spend the same remaining dollars. ADR-090 now exposes
each image and verifier request, so admission can reserve for the actual work.

## Decision

Serialize the provider body once. Before transport, quote that exact body and
persist its digest, policy version, token bounds and USD reservation under the
existing task lock. Admission requires recorded/attested cost plus outstanding
reservations plus the new reservation to fit the run limit. Use integer USD
micro-units for comparisons. Cancellation or restart does not release funds.

Release the unused reservation only on complete provider usage at known rates,
definite non-acceptance, or an existing exact-call administrator settlement.
Successful replies without usage and per-image estimates retain their reserve.
Persist higher actual costs even if the quote was exceeded; hold further calls
for review rather than suppress the receipt. Historical evidence stays unchanged.

The quote policy covers current Studio text/vision and image adapters. It uses
UTF-8 byte bounds, schema/framing allowance, explicit completion limits and
conservative vision bounds; OpenAI text pins standard service tier. Auto image
quality/size reserves for their maximum, without changing requested fidelity.
Unpriced or unbounded payloads refuse dispatch. Quotes are conservative operating
estimates, not a provider invoice guarantee. Provider price or tokenization drift
can invalidate a bound; overrun detection is mandatory. No raw prompt/image is
stored in the ledger. Office/day/role limits remain additional required scope.

## Price and bound evidence

Read 2026-09-27: OpenAI [pricing](https://developers.openai.com/api/docs/pricing),
[vision](https://developers.openai.com/api/docs/guides/images-vision), and
[image generation](https://developers.openai.com/api/docs/guides/image-generation);
Google [pricing](https://ai.google.dev/gemini-api/docs/pricing) and the three image
model cards linked there. Sunburst's published image calculator is an estimate;
the policy doubles its square-grid token bound. Google reserves its model output
limit at the highest output modality rate, including possible thinking output.
No invoice or paid request is represented by this research.

## Alternatives and verification

A fixed per-call price misses variable image quality and long inputs. A process
mutex fails across Core instances. Releasing on timeout permits double spending.
Verify competing PostgreSQL admissions, restart persistence, missing usage,
settlement, immutable quotes, overrun retention, exact transport-body binding,
unpriced/malformed input rejection, and visible remaining/reserved funds in Desk.


## Production-tier correction during qualification

The first policy always reserved Astra long-context prices. A production-tier
v3 workflow then refused a layout under the default USD2 cap although the entire
conservative input bound was below the272K long-context threshold. Policyv2
selects short versus long prices using that upper input bound, preserving byte,
schema, framing, vision and maximum-output headroom. It changes no model, quality,
output limit or run cap. Both production and development v3 fixtures now run the
same full workflow in the normal suite. Refusal diagnostics show the required
reservation and remaining funds. Earlier v1 quotes are immutable evidence.
