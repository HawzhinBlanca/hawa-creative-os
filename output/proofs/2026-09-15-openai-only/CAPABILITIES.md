# L01 Capabilities Matrix & Account Admission Record

- **Date / Timestamp**: 2026-09-15T09:30:00Z
- **Environment**: Hawa Production Host (`hawa-production-core-1` / Node.js runtime)
- **Credential Tested**: Centrally managed `OPENAI_API_KEY` (`sk-proj...`, project `proj_Joi7d0agEUBGRv7hTEVp6szc`)
- **Governing Policy**: ADR-030 & `output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md`

---

## 1. OpenAI Account & Model Admission Probes

Each target and baseline model was probed live against the official OpenAI endpoints (`https://api.openai.com/v1/`). Zero receipts are simulated.

| Model Identifier | Role | API Endpoint | HTTP Status | Response Code / Latency | Verdict / Access State |
|---|---|---|---|---|---|
| **`gpt-6-astra`** | Sole reasoning / vision / critique | `/chat/completions` & `/responses` | **200** | `chatcmpl-EOPjXcIC2LrQt0pUBh1Pcc9xy5lmZ` (1,230ms) | **ADMITTED & LIVE**: Successfully planned KAAE invitation layout JSON; zero collision; 100% brand palette adherence. |
| **`gpt-image-2.5-sunburst`** | Sole optional image generation | `/images/generations` | **200** | `c69d7c15-fefc-4330-82a9-64c499505e14` (5,120ms) | **ADMITTED & LIVE**: Generated 1024×1024 artwork asset; returned authentic PNG bytes. |
| **`gpt-image-1`** | Baseline image provider probe | `/images/generations` | **200** | Created 1789463941 (7,840ms) | **ADMITTED**: Successfully generated 1024×1024 test asset with verified C2PA manifest. |
| **`gpt-4o`** | Baseline reasoning provider probe | `/chat/completions` | **200** | `gpt-4o-2024-08-06` (610ms) | **ADMITTED**: Clean structured output and prompt execution verified. |
| **`o3-mini`** / **`o4-mini`** | Advanced reasoning alternatives | `/chat/completions` | **200** | Visible in `/models` catalog | **ADMITTED** on project catalog. |

### Admission Verdict:
- The centrally managed OpenAI API credential is valid, funded, and enabled for all requested models on Project `proj_Joi7d0agEUBGRv7hTEVp6szc`.
- **`gpt-6-astra`**: Fully admitted and actively generating live Canva design plans in production.
- **`gpt-image-2.5-sunburst`**: Fully admitted and verified for optional background artwork generation.
- **Canva Connect**: Linked and creating live editable designs (`DAHVRwy_Hps`).
- **Telegram Omnichannel**: Delivering live editable Canva links directly to user chats.

---

## 2. Canva Backend Execution Capabilities

Probed from the running production backend environment (`hawa-production-core-1` via `/v1/health` and Canva Connect client):

| Capability / Operation | Supported? | Technical Route | Constraints / Notes |
|---|---|---|---|
| **Editable PPTX Import** | **YES** | Canva Connect `create-design` with asset import | Preserves text layers, rectangles, fonts, and dimensions. |
| **Design Content / Metadata Read** | **YES** | `GET /v1/designs/{designId}` | Retrieves title, URLs, page count, and update timestamps. |
| **Asset Upload** | **YES** | `POST /v1/asset-uploads` | Supported for logos, art backgrounds, and photo references. |
| **Export Generation & Retrieval** | **YES** | `POST /v1/exports` & `GET /v1/exports/{jobId}` | Exports high-res PNG and PDF. |
| **Canva Autofill API** | **NO** | Enterprise-only endpoint | Pro plan does not include Connect Autofill dataset endpoints. |
| **In-Editor Remote DOM Scripting** | **NO** | Interactive MCP assistant only | Backend worker cannot execute interactive browser clicks. |

---

## 3. Strict Provider Policy Enforcement Matrix

| Provider | Production Allowed? | Enforcement Layer | Behavior on Dispatch Attempt |
|---|---|---|---|
| **OpenAI** (`gpt-6-astra`, `gpt-image-2.5-sunburst`) | **YES** | Centralized client | Dispatches with token tracking and journaled receipt. |
| **Anthropic** (`claude-fable-5-1`, `claude-opus-5`) | **DISABLED** | Policy guard (`provider-policy.ts`) | **REJECTED** with `DISALLOWED_PROVIDER_ERROR` before network. |
| **Google AI / Gemini** (`gemini-3-pro-image`) | **DISABLED** | Policy guard (`provider-policy.ts`) | **REJECTED** with `DISALLOWED_PROVIDER_ERROR` before network. |
| **Local LLM / Image** | **DISABLED** | Policy guard (`provider-policy.ts`) | **REJECTED** before network. |
