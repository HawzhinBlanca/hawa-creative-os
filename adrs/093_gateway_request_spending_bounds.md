# ADR-093 — Bound shared gateway requests before transport

Date: 2026-09-27
Status: Accepted for implementation; live billing qualification remains open
Requirements: FR-059, FR-062, FR-065, FR-079, NFR-001

## Evidence and decision

The shared ModelGateway checked only a zero cost budget. Its Google/OpenAI
requests omitted native output caps, provider-wide prices ignored the selected
model, missing usage invented 520/140 tokens, and Google thought tokens were
omitted. A durable reservation cannot protect this path until requests are bounded.

Quote the exact serialized provider body before fetch using a versioned, expiring
price policy. Refuse invalid budgets, unsupported options/models, oversized inputs
and quotes above the caller's allowance before dispatch. Do not lower a supplied
output limit or switch models to make a quote fit. The documented default output
limit is 2,048 combined generated tokens (previously only Anthropic applied this
default); callers can explicitly request a different limit within provider limits.
Return the applied token bounds and body hash with the receipt. Keep native
reasoning defaults, model choices, image detail and caller dollar limits unchanged.

One elapsed-time allowance covers all attempted providers. Explicit rejection may
follow the existing authorized fallback; uncertainty, unusable output and observed
bound overruns stop without another paid call. Missing/malformed usage stays
unknown with the reservation intact. Complete usage yields a conservative cost
estimate, never a claim of invoice verification. Google output includes thoughts;
Anthropic cache input categories count; OpenAI input is priced conservatively to
cover cache writing and the Sol long-context tier. Preserve observed overruns.

Input bounds use twice the UTF-8 text/schema bytes plus structural headroom and
documented maximum image-token charges. This is an operating reservation, not a
provider invoice guarantee. It needs live billing calibration. Unknown payload
features require a reviewed policy before they can spend. These request bounds
do not replace the separate durable office/client/role/day admission work.

## Primary sources checked 2026-09-27

- [Google pricing](https://ai.google.dev/gemini-api/docs/pricing): Gemini 3.8 Flash standard input/output USD 0.75/3.75 per million through 2026-12-31.
- [Generate Content thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking): output limit includes thought tokens; truncation is not a usable answer.
- [Google media resolution](https://ai.google.dev/gemini-api/docs/media-resolution): default image approximately 1,120 tokens; reserve 2,240 plus structure per image.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing): Sonnet 5 USD 2/10; Opus 5 USD 5/25, with separate cache categories.
- [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision): image cap 4,784 visual tokens for these models.
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol): USD 4/20 through at least 2026-11-21; >272K input uses 2x input/1.5x output; cache writes 1.25x input.
- [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1) and [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o): USD 2/8 and 2.5/10 respectively.
- [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision): Sol auto/original capped at 30,000 patches with 1.2 multiplier; tile-model admission conservatively reserves sixteen tiles: both axes fit within 2048 pixels, and smaller dimensions are not enlarged.

The initial policy expires before 2026-11-22 UTC. A reviewed update is required;
expired or unpriced calls cannot silently fall back to old provider-average prices.

## Required verification

Zero transport on unaffordable/invalid/unpriced/expired requests; unchanged native
output cap and exact body hash; thought/cache accounting; missing/invalid usage
retains uncertainty; no second paid request after overrun; authorized rejection
fallback shares the deadline; connected evaluation persistence preserves receipts.
