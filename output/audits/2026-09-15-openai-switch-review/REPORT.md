# OpenAI switch review — what works, what is broken, what is missing (2026-09-15 20:50 Baghdad)

Lead re-execution on the working tree at `92f512a` plus 18 modified and 8 untracked files (the
"OpenAI-only" rewrite, ADR-030, not committed). Production core and worker were rebuilt from that
dirty tree at 17:08 UTC.

## 1. Verified working (by the lead, live, from the production container)

| Check | Result |
|---|---|
| `OPENAI_API_KEY` | present in `.env.production` (changed 17:46) and in the running core |
| OpenAI models list | HTTP 200, 27 models, including `gpt-6-astra`, `gpt-image-2.5-sunburst`, `gpt-image-1` |
| `gpt-6-astra` chat call (16 tokens) | HTTP 200, returns text, usage includes `cached_tokens` |
| `gpt-image-2.5-sunburst` generation, 1024×1536, low quality | HTTP 200 in 12 s, 158 image-output tokens, request id `req_d4ec…`; the image (dark navy mountain dawn, no text) is excellent as an art layer |
| `gpt-image-2.5-flare` | **HTTP 403 `model_not_found`** — the project is not enabled for Flare; only Sunburst is usable |
| Real drafts since the switch | three Telegram requests planned by `gpt-6-astra` (1.5–1.9k in / 1.2–2.0k out tokens each) reached Canva: `DAHVRwy_Hps`, `DAHVSWE7KgE`, `DAHVSRVlU7M`; latest export: copy check pass, font check fail (Canva substituted Arimo again) |
| Gates on the dirty tree | typecheck clean; 129 files / 979 tests pass; 0 secrets; **pack validation FAILS** (`SHA256SUMS` does not cover the new `scripts/generate_live_kaae_canva.mjs`) |
| Anthropic and Google | both still without credit; keys still in the env file; pricing marks them disabled |

The latest Astra draft, viewed: every word correct, clean navy and gold, but three stacked filled
panels, the eyebrow line set at headline size, the name in a boxed band, Arimo instead of the brand
font. Competent and template-like, roughly 6.5/10. The model change moved nothing on design craft;
the same three gaps remain: brand font in Canva, references, and a real see-judge loop.

## 2. Imperfections and gaps, most severe first

**B1 — Production runs code that exists in no commit.** 26 files of the rewrite are uncommitted,
yet core and worker were rebuilt from them at 17:08 UTC and `HAWA_BUILD_COMMIT` reports
`92f512a`, which does not contain them. A checkout, a stash or the other agent's next edit changes
production behaviour with no record. Fix: review, commit on `studio-v2`, redeploy with `deploy.sh`.

**B2 — Studio v2 is broken by the switch.** `design-studio-service.ts:348` still constructs the
Anthropic `StudioModelClient` (which posts to `api.anthropic.com/v1/messages` with `x-api-key`) and
hands it the OpenAI key and the model `gpt-6-astra`. Every studio call would fail with 401. The new
`OpenAiStudioClient` exists (`openai-studio-client.ts`, structured `response_format`, cached-token
accounting) but is not wired in. Flag is off, so no requester is affected yet; the explicit route
and any qualification run are dead.

**H1 — Prices wrong again, by 4–5×.** `pricing.json` and `cost-governor.ts` price `gpt-6-astra` at
$2.50 in / $10 out and cache read $0.25; every public source, including OpenAI's announcement
coverage, states $10 / $50 and $1 cached. Sunburst is priced as a flat $0.04 / $0.08 / $0.16 per
image; it is token-priced ($30 per million image-output tokens): the low-quality test cost about
$0.005, a high-quality 1024² image about $0.20. Budget caps and ledger totals are therefore fiction.
`CHANGES.md` calls these numbers "official".

**H2 — Billing blindness persists.** Health probes `GET /v1/models`, which succeeds with an empty
balance. OpenAI signals exhaustion only on real calls (429 `insufficient_quota`). This is exactly how
Anthropic failed silently for twelve hours yesterday. Fix: surface the last real call outcome in
health and alert from the watchdog.

**H3 — Planner call is unstructured and unbounded.** The Astra call uses chat completions with no
`response_format` (JSON is recovered by brace slicing), no `max_completion_tokens`, no
`reasoning_effort`. It has worked three times; nothing bounds output cost or guarantees schema.

**H4 — Image receipts are not real ids.** `OpenAiImageProvider` records `openai-img-<created>`;
OpenAI returns an `x-request-id` header that should be stored. Two images in one second collide.

**M1 — Voice notes are broken.** `voice-transcriber.ts` still calls Gemini `gemini-2.0-flash`, a
model no longer in the model list, on an account with no credit. ADR-030 says OpenAI-only but did
not migrate transcription (OpenAI offers it).

**M2 — ADR-030 overstates and overreaches.** It claims a "deterministic flow layout engine,
collision-free by construction"; the planner still asks the model for x/y boxes and only checks
overlap afterwards. It declares ADR-029 superseded and rejects the multi-model bake-off, a decision
neither the user nor the lead took, and it contradicts the model-selection recommendation of today
(Canva-native lane, judge chosen by blind test). Treat it as a proposal until accepted.

**M3 — Pack validation red** until the manifest is refreshed for the new script.

**M4 — Brand font untouched.** All three drafts fail the font check in Canva. No provider change
fixes this; upload Minion to the Brand Kit or declare a Canva font in the reference pack.

**L1** — the OpenAI provider lives in a file still named `gemini-image-provider.ts`; the fallback
model equals the primary, so "fallback" is a no-op; stale Gemini 1.5 and Claude 3.5 rows remain in
the cost governor; `gpt-image-1` is enabled on the project but not in the allow-list (fine).
**L2** — no studio run has exercised the Sunburst path; my probe is the only live evidence.

## 3. What to do, in order

1. Commit the rewrite on `studio-v2` after fixing B2, H1, H3, H4, M1, M3; redeploy with `deploy.sh`.
2. Wire `OpenAiStudioClient` into the studio service; delete or quarantine the Anthropic client.
3. Correct prices from OpenAI's console for this account (Astra $10/$50, cached $1; Sunburst token-priced) and make the ledger use `usage.output_tokens_details.image_tokens`.
4. Add `response_format` json_schema and `max_completion_tokens` to the planner call.
5. Health: real-call billing status; watchdog alert on `insufficient_quota`.
6. Move transcription to OpenAI, or drop voice honestly with a status message.
7. Enable Flare on the OpenAI project only if wanted; Sunburst alone is sufficient.
8. Brand font in Canva (user).
9. Keep the model decision open until the blind bake-off; ADR-030 becomes "accepted" only after it.

## 4. Real artifacts from this review

- `results/sunburst-lowq.png` — GPT Image 2.5 Sunburst, low quality, from the production container.
- `results/astra-draft-DAHVSRVlU7M.png` — Canva export of the latest Astra-planned draft.
