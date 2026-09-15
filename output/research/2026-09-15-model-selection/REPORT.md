# Which models and which agent for Hawa's Canva designs — research and real results

**Date:** 2026-09-15 · **Author:** lead session (Claude Fable 5.1) · **Status:** recommendation, not a decision. Everything marked *measured* was produced or verified by the lead today; everything marked *reported* comes from the cited public source.

## 1. The answer in one paragraph

"GPT-6 Astra" is a reasoning model, not an image model; it cannot draw a poster. The models that draw the best posters today (GPT Image 2.5, Nano Banana 2, MAI-Image-2.6, Ideogram 4, Recraft) all rasterise the text, and today's tests show why that is disqualifying for institutional invitations: the best free model produced a beautiful layout with "Annoumement", "Kukudstian" and "Abbunlah" in it, and turned Sorani Kurdish into unreadable shapes while adding a sun emblem it was told not to draw. So the design quality you want does not come from picking a new image model. It comes from (a) letting a strong image model do what it is good at — composition, atmosphere, art — as a *reference or background only*, (b) keeping every letter of copy native and exact, and (c) the one thing I found that changes the plan: Canva now exposes an official MCP server through which an agent can generate designs with Canva's own engine and then **edit text and elements inside the Canva design natively** (replace text, find-and-replace, colours, sizes, alignment). That is the "AI agent that works with the Canva we have". The recommended stack is below; nothing in it should be adopted without the 20-brief blind bake-off in section 7, which I will run myself once the accounts have credit.

## 2. What the names you heard actually are (September 2026)

| Model | What it is | Evidence | Price | Arabic script | Fit for Hawa |
|---|---|---|---|---|---|
| **GPT-6 Astra** (`gpt-6-astra`) | OpenAI flagship reasoning model, released 3 Sep 2026; text out, image/PDF in, 1M context, computer use via screenshots in the Responses API | reported: OpenAI, CNBC, Fortune | $10 in / $50 out per MTok (same as Fable 5.1) | n/a (text model) | candidate for planner/critic/judge; also the only route to an "operator" that could drive the Canva editor like a human (slow, costly, brittle) |
| **GPT Image 2.5 Flare / Sunburst** (`gpt-image-2.5-flare`, `-sunburst`, API 8 Sep 2026) | OpenAI image generation (Flare) and editing with up to 16 reference images, transparent background (Sunburst) | reported: #1 and #2 on the Artificial Analysis text-to-image arena, Elo 1188 / 1182 | ≈ $0.21 per high-quality image (token priced: $30/M image-output tokens) | reported ~99% character accuracy on Arabic for GPT Image 2; still "review every character" | best choice for concept posters and art layers; Sunburst can also *remove text* from a concept image to make the art layer |
| **Nano Banana 2** (`gemini-3.1-flash-image`) | Google image model, 4K | reported: Elo 1122, rank 6 — above Nano Banana Pro | $0.067 | multi-script, short text reliable, long text less so | we already hold the key; cheaper and higher-ranked than the Pro we wired |
| **Nano Banana Pro** (`gemini-3-pro-image`) | Google, up to 14 reference images, 4K | reported: Elo 1098, rank 10; measured: real 2K image yesterday | $0.134 | reported strongest multilingual text (94–97%), Arabic joins mostly correct | current art provider; keep as fallback to Nano Banana 2 |
| **MAI-Image-2.6** | Microsoft image model, Azure Foundry preview | reported: Elo 1147, rank 4; +91 Elo in text rendering vs 2.5 | ≈ $0.039 | not documented | best price/quality if you accept an Azure account; not needed now |
| **Qwen-Image-3.0-Pro** | Alibaba, built for text-heavy layouts, 4,500-token prompts, 10-px text, 12 languages | reported: Elo 1085 | $0.04–0.075 | Arabic not among the listed languages | interesting for dense posters; unproven for Sorani |
| **Ideogram 4** | 9.3B open-weight typography model (weights non-commercial), bounding-box text placement, 2K | reported: strongest open-weight typography, ~97% English text; Elo ~1017 (rank ~30) overall; "non-Latin scripts render unreliably" | $8/month app or hosted API | unreliable | **not for us**: Latin-only strength, licence, and it still rasterises copy |
| **Recraft V4 / V4.1 Vector** | the only model producing true editable SVG; short/mid text; PNG/SVG/PDF/Lottie | reported: Recraft docs, Replicate | $0.04 raster, $0.08 vector, $0.25/$0.30 Pro | not documented | optional: brand motifs and icons as vectors; not a poster engine; "V4 Styles" (Aug 2026) claimed by a partner blog but the docs say style creation is not yet in V4 — unverified |
| **Z-Image Turbo, Qwen-Image** (open, free on Hugging Face) | fast open models | measured today | free | Sorani garbled (measured) | free concept references; never for final text |
| **Claude Fable 5.1 / Opus 5 / Sonnet 5** | our current planner/critic/judge family; vision, JSON-schema outputs, 1M context | measured in production yesterday (95 real calls) | $10/$50, $5/$25, $2/$10 per MTok | reads Sorani correctly (measured) | keep; bake off against Astra and Gemini 3.1 Pro |
| **Gemini 3.1 Pro / 3.8 Flash** | Google reasoning models; key already held | reported | lower than Fable | good | cheap judge/brief candidates for the bake-off |

Design-specific evidence, honestly stated: the only rigorous benchmark of frontier models on graphic-design tasks (Graphic-Design-Bench, April 2026) tested GPT-5.4, Claude Opus 4.6 and Gemini 3.1 Pro and found GPT-5.4 strongest at layout and typography *understanding* and every model weak at precision. No published benchmark yet covers GPT-6 Astra, Fable 5.1 or Opus 5 on design. Anyone who tells you which of these designs best is guessing; the bake-off in section 7 is how we stop guessing.

## 3. Real results produced today

Both paid accounts are empty: Anthropic returns HTTP 400 "credit balance is too low" and Google returns 429 "prepayment credits are depleted" for image *and* text models (the $48.96 added yesterday was consumed by the agent's studio runs and probes). So today's live generations used free open models on Hugging Face, with the exact copy of your 9 September invitation.

**Z-Image Turbo, English** (file `zimage-en.png`): a genuinely good invitation composition — gold frame, reserved logo square, eyebrow, gold title, name line, body, date, venue, footer, dark mountain horizon. Copy errors, verbatim: "Annoumement", "Kukudstian Accrediating", "Educitaon", "Abbunlah". Four wrong words out of about forty. As a *design reference* it is excellent; as a deliverable it is unusable.

**Z-Image Turbo, Sorani** (file `zimage-ku.png`): layout fine, right-aligned, but the Kurdish text is not the text — letters replaced and merged, digits wrong — and the model drew a 20-ray sun emblem despite being told to draw no emblem. Two lessons the pipeline already encodes and must keep: Arabic-script copy is never rasterised, and image models are never allowed near logos, seals or flags.

**Qwen-Image** (Hugging Face space): the worker failed three times today (ZeroGPU runtime errors); no result.

**Nano Banana Pro / GPT Image 2.5 / Fable**: not run today for lack of credit. Yesterday's real Nano Banana Pro result (mountain-horizon art layer, no text) is in the proof folder and was correct.

What the results prove: composition taste in image models is now high enough to lead the design; text fidelity is not, and never will be checked by hand at 20 designs a day. The architecture must therefore separate "what it looks like" (image model, references) from "what it says" (native text, verified byte for byte).

## 4. The Canva finding that changes the plan

Canva's official MCP server (`https://mcp.canva.com/mcp`) exposes to an AI agent, on all plans: `generate-design` (Canva's own design generation from a prompt, returning candidates), `create-design-from-candidate`, `start-editing-transaction` → `perform-editing-operations` → `commit-editing-transaction` (operations: `replace_text`, `find_and_replace_text`, `update_fill`, `resize_element`, delete/insert media, formatting of colour, alignment, line height, font size, weight and style), `get-design-content`, `get-design-thumbnail`, `export-design`, asset upload, folders and comments. Rate limits are per user and per tool (20 req/min on generation and editing, 50 on operations, 100 on reads). Pro adds resizing and brand-template search; Enterprise adds autofill and automatic brand-kit application. The Apps-SDK "Design Editing API" that Canva announced is browser-only and cannot be used by a backend — the MCP is the server-reachable route.

Why this matters: our whole PPTX pipeline exists because the Connect API cannot touch elements inside a design. Through the MCP an agent can take a Canva-generated candidate — Canva's templates, fonts and elements — and set our exact copy into it natively, recolour to the brand palette, resize, and export for our existing byte-level checks. That is closer to "a designer working in Canva" than anything we can render ourselves.

Constraints that are real: every call runs under one human's OAuth token (the art director's account, exactly as our Connect integration already does); "shared agents must not execute using another user's token"; "avoid bulk automation that circumvents per-user limits"; Brand Kit content must not be cached outside Canva. Our volume (tens of designs a day, one office account) fits; a multi-tenant SaaS would not. Sorani font coverage inside Canva's generated designs and the quality of `generate-design` for institutional work are unknown until tested. I cannot test it from this session: the Canva connector is available here but not authorised.

## 5. Recommended stack — smart, high-end, lean

| Role | Primary | Fallback | Why |
|---|---|---|---|
| Design production (new) | **Canva-native agent lane**: Fable 5.1 driving the Canva MCP — generate 3 candidates → judge → native text replacement with exact copy → palette/size/alignment edits → commit → export → existing QA | Studio v2 (fixed) with local render + PPTX import | uses Canva's engine, fonts and elements; no renderer, no PPTX, no font stand-ins; text stays native |
| Planner / critic / judge | Claude Fable 5.1 (already wired, vision, JSON schema, reads Sorani) | Opus 5; bake-off contenders GPT-6 Astra, Gemini 3.1 Pro | same price as Astra; the bake-off decides |
| Cheap stages (brief, concept text) | Sonnet 5 ($2/$10) or Gemini 3.8 Flash | — | 5× cheaper for stages that do not look at pixels |
| Concept posters and art layers | GPT Image 2.5 Sunburst (edit with references, text removal, #1 arena) | Nano Banana 2 (held key, rank 6, $0.067); Nano Banana Pro | art and references only; never copy |
| Vector motifs (optional) | Recraft V4 Vector ($0.08) | procedural SVG motifs we already have | only if the art director wants illustrated marks |
| Final text | native Canva text, exact copy, verified from the exported PPTX | — | non-negotiable, proven today |

Cost per design (estimate): Canva-native lane ≈ $0.30–0.80 (judge calls plus a few edit calls; Canva generation is within the plan); Studio v2 lane $2–4 as measured. Latency 1–3 minutes.

Not recommended: Ideogram 4 (licence, Latin-only strength, rasterised text), a GPT-6 "operator" driving the Canva browser (the MCP gives the same edits deterministically at a fraction of the cost), Canva Enterprise for autofill (not needed for this lane), any local GPU image stack.

## 6. What stays exactly as it is

Restate durability, PostgreSQL journals and receipts, RLS, exact-copy and font checks on the exported PPTX, honest Telegram status, the watchdog and backups. The new lane is one more journaled path behind a flag, judged by the same deterministic QA.

## 7. How the choice gets made — the bake-off I run

20 briefs (10 English, 10 Sorani; five sizes) through three configurations: Canva-native lane, Studio v2 with GPT Image 2.5, Studio v2 with Nano Banana 2. Judge models rotated (Fable 5.1, GPT-6 Astra, Gemini 3.1 Pro) with order swap; you rate blind pairs; hard QA must be zero-escape. Budget: about $60 Anthropic, $40 OpenAI (image + Astra), $30 Google. Output: a decision table with real costs, real judge agreement, and your preference rate. Only then does ADR-030 get written.

## 8. What I need from you

1. Add credit: Anthropic (~$60) and Google AI Studio (~$30). Nothing runs without them; production drafts are failing right now.
2. Create an OpenAI API key with ~$40 (for GPT Image 2.5 and the Astra bake-off) and give it to the rotation helper, never to chat.
3. Authorise the Canva connector for this Claude session (Settings → Connectors → Canva, with the art director's Canva account) so I can test the MCP lane end to end on a real brief and show you the Canva design.
4. Confirm the Canva plan you are on (Pro or Teams is enough for this lane).

## Sources

- GPT-6 Astra: [OpenAI announcement](https://openai.com/index/gpt-6-astra/), [CNBC 3 Sep 2026](https://www.cnbc.com/2026/09/03/open-ai-astra-gpt-6-cyber.html), [Fortune](https://fortune.com/2026/09/03/openai-debuts-gpt-6-astra-computer-use-greg-brockman-says-start-of-agi/), pricing [Yotta Labs](https://www.yottalabs.ai/post/gpt-6-astra-pricing-api-cost-2026), [StartupHub](https://www.startuphub.ai/ai-news/technology/2026/gpt-6-astra-api-brings-computer-use-to-developers)
- Image arena and prices: [Artificial Analysis text-to-image leaderboard](https://artificialanalysis.ai/image/leaderboard/text-to-image) (read 2026-09-15)
- GPT Image 2.5: [GLBGPT API guide](https://www.glbgpt.com/hub/gpt-image-2-5-api-guide/), [eesel pricing](https://www.eesel.ai/blog/chatgpt-images-2-5-pricing), Arabic claims [Picsart](https://picsart.com/ai-models/gpt-2/), [Apiyi](https://help.apiyi.com/en/gpt-image-2-vs-gpt-image-1-5-upgrade-8-features-en.html), review caution [Atlas Cloud](https://www.atlascloud.ai/blog/tips/gpt-image-2.5-text-rendering)
- Nano Banana 2 / Pro: [DeepMind](https://deepmind.google/models/gemini-image/flash/), [Flowith text test](https://flowith.io/blog/nano-banana-2-vs-gpt-image-text-rendering-2026/), [Arabic text](https://jeennee.ai/en/articles/nano-banana-pro-arabic-text), [DejaOffice](https://www.dejaoffice.com/blog/2026/05/26/nano-banana-pro-the-image-model-with-the-best-text-rendering-right-now/)
- MAI-Image-2.6: [Microsoft Foundry blog](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/mai-image-2-6-and-mai-image-2-6-flash-quality-and-speed-at-production-scale/4550970), [OpenRouter](https://openrouter.ai/microsoft/mai-image-2.6)
- Qwen-Image-3.0: [llm-stats](https://llm-stats.com/blog/research/qwen-image-3-0-launch), [Kie](https://kie.ai/qwen-image-3)
- Ideogram 4: [Together AI](https://www.together.ai/models/ideogram-40), [fal](https://fal.ai/ideogram-4), [BudgetPixel review](https://budgetpixel.com/models/ideogram-v4), weights [ideogram-ai/ideogram-4-fp8](https://hf.co/ideogram-ai/ideogram-4-fp8)
- Recraft V4: [Recraft docs](https://www.recraft.ai/docs/recraft-models/recraft-V4), [Replicate blog](https://replicate.com/blog/recraft-v4), [MindStudio](https://www.mindstudio.ai/blog/recraft-v4-1-brand-design-logos-svg-assets)
- Canva: [MCP overview](https://www.canva.dev/docs/mcp/), [tools and rate limits](https://www.canva.dev/docs/mcp/tools/), [perform-editing-operations](https://www.canva.dev/docs/mcp/tools/perform-editing-operations/), [usage policy](https://www.canva.dev/docs/mcp/usage-policy/), [Apps SDK Design Editing](https://www.canva.dev/docs/apps/design-editing/), [Connect changelog](https://www.canva.dev/docs/connect/changelog/), [Claude connector guide](https://claudelab.net/en/articles/cowork/canva-claude-integration)
- Benchmarks: [Graphic-Design-Bench](https://arxiv.org/html/2604.04192v2), [GraphicWeaver](https://aclanthology.org/2026.alvr-main.5/), [Design Arena](https://www.designarena.ai/leaderboard)
- Hawa evidence: `output/proofs/2026-09-14-design-studio-v2/T07_ART/probe_meta.json`, `output/audits/2026-09-15-deepest-audit/REPORT.md`
