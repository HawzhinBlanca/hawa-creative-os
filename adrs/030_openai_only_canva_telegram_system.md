# ADR-030: Strict OpenAI-Only, Canva-Only, Telegram-First Design System

**Date:** 2026-09-15  
**Status:** Accepted for implementation  
**Supersedes:** ADR-029 (multi-model tournament, Claude Fable/Opus pipelines, Gemini image provider), ADR-016 (Figma), ADR-018 (Polotno)  
**Normative Assignment:** `output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md`

---

## 1. Context & Problem Statement

The Design Studio v2 pipeline (ADR-029) introduced a 10-stage architecture using Claude Fable 5.1 and Gemini 3 Pro Image. While it established local rendering and metric verification, production audits and user evaluations on 2026-09-15 revealed severe operational and aesthetic defects:
1. **Model Proliferation and Latency/Token Waste**: 15–25 calls across multiple providers (Fable 5.1, Opus 5, Gemini) created prohibitive latency (2–6 minutes per brief), brittle external dependencies (Anthropic credit exhaustion halted Telegram intake), and significant token expense.
2. **Spatial Coordinate Failure & Overlapping Text**: Autoregressive language models cannot reliably calculate font metrics, letter-tracking, and line wrapping in freehand JSON. Despite multiple vision critique rounds, text boxes frequently overlapped or drifted outside safe margins.
3. **Provider Fragmentation**: Supporting separate Anthropic, Google, and OpenAI credentials simultaneously increased secret-sprawl, billing complexity, and failure modes.
4. **Primary User Workflow**: The user explicitly operates via Telegram for briefs, progress, previews, revisions, and final delivery, using Canva as the sole editable cloud studio.

---

## 2. Architectural Decisions

### 2.1 Strict OpenAI-Only Model Policy
- **Sole Reasoning, Vision, & Critique Model**: `gpt-6-astra`. All briefing, typography role assignment, layout direction, and visual inspection calls are routed exclusively to `gpt-6-astra`.
- **Sole Optional Artwork Model**: `gpt-image-2.5-sunburst`. Invoked strictly when the brief requests and benefits from imagery. When `imagery: 'none'`, image-model calls must be exactly zero.
- **Disabled Runtime Providers**: Anthropic (`claude-*`), Google AI (`gemini-*`), and local LLM/image services are disabled in production server dispatch. Any attempt to dispatch to disabled providers fails closed prior to network access.
- **Single Centrally Managed OpenAI Credential**: Reuses the validated `OPENAI_API_KEY` for both reasoning and artwork generation without exposing credentials in logs, URLs, or artifacts.

### 2.2 Deterministic Flow Layout Engine (Collision-Free Guarantee)
To permanently eliminate overlapping text:
- The model assigns semantic roles (`eyebrow`, `headline`, `subhead`, `details`, `cta`), palette roles, and alignment.
- Coordinate calculation (`x`, `y`, `width`, `height`, line breaks) is computed by deterministic layout rules (vertical stack with dynamic bounding-box expansion based on measured font metrics).
- Mathematically guarantees zero text overlap by construction.

### 2.3 Canva-Only Editing and Export Studio
- Canva remains the sole production design editor and export studio via established Canva Connect API and editable PPTX transfer.
- Canvas layers are structured so that background artwork is a distinct image asset, with text blocks and official logos natively editable above it.
- Never generate text directly inside the raster background artwork.

### 2.4 Telegram-First Omnichannel Interaction
- Telegram is the primary interface for intake, clarification, progress updates, preview delivery, revision requests, and final file handoff.
- Inbound requests create immutable, client-scoped tasks.
- Outbound replies return captured previews and direct Canva edit links to the requesting chat.
- Revisions link directly to the parent task and expected revision version.

### 2.5 Invariant Preservation
- **Durable Execution**: Retains PostgreSQL, Restate workflow engine, client-scoped service identities (ADR-027), outbox pattern, and append-only audit journals.
- **Client Scope & Brand DNA**: Preserves immutable client scope once retrieval begins. Brand assets, logos, and approved palettes are loaded strictly from versioned client snapshots.
- **Zero Fabrication**: Receipts, costs, latency, and test outcomes must reflect genuine execution.

---

## 3. Consequences & Migration

- **Positive**: Single API provider, zero token waste from redundant 20-stage tournaments, sub-30s turnaround, guaranteed non-overlapping text, and full Telegram-first lifecycle.
- **Negative**: Requires graceful handling of account access boundaries during staged rollout.
- **Compatibility**: Legacy outbox contracts and Canva binding repositories remain intact; external interfaces remain stable.

---

## Amendment, 2026-09-18: configurable models; Google allowed for artwork only

At the owner's request ("we want top end flexibility"), every model parameter is configuration rather than code:

- `HAWA_MODEL_TIER` (`production` | `dev`) picks the text models; `HAWA_MODEL_LAYOUT`, `HAWA_MODEL_CRITIQUE`, `HAWA_MODEL_JUDGE` and `HAWA_MODEL_TEXT` override one role. Text, layout, critique and judge calls remain OpenAI-only; the allowlist still refuses anything else at dispatch.
- `HAWA_IMAGE_PROVIDER` (`openai` | `google`), `HAWA_IMAGE_MODEL`, `HAWA_IMAGE_SIZE`, `HAWA_IMAGE_QUALITY` and `HAWA_IMAGE_ASPECT` set image generation. Google's image models (`gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image`) are allowed for artwork only, with `GEMINI_API_KEY`, and only when the owner selects them. The default stays OpenAI.
- Image cost is recorded from the provider's reported token usage, else its published per-image price, else an operator estimate, and says which. Every billed attempt counts, including images the checks rejected.
- Core `/health` → `models` shows the settings in force and whether the selected image provider has a key.
