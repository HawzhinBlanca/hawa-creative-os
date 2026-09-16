# Changes Record: OpenAI-Only, Canva-Only, Telegram-First System

- **Date**: 2026-09-15
- **Branch**: `studio-v2`
- **Governing ADR**: [`adrs/030_openai_only_canva_telegram_system.md`](file:///Users/hawzhin/Hawdesign/adrs/030_openai_only_canva_telegram_system.md)
- **Specification**: [`output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md`](file:///Users/hawzhin/Hawdesign/output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md)

---

## 1. Architectural Changes Summary

1. **Strict One-Provider Policy Enforced at Domain Boundary**:
   - Implemented `assertModelAllowed` and `assertProviderAllowed` in [`packages/domain/src/provider-policy.ts`](file:///Users/hawzhin/Hawdesign/packages/domain/src/provider-policy.ts).
   - Only `gpt-6-astra` (reasoning, vision, critique) and `gpt-image-2.5-sunburst` (optional image generation) are allowed under OpenAI.
   - Any attempt to invoke Anthropic (`claude-*`), Google Gemini (`gemini-*`), or local mock models fails closed with `DisallowedProviderError` before network egress.

2. **Durable OpenAI Studio Client**:
   - Created [`packages/creative/src/studio/openai-studio-client.ts`](file:///Users/hawzhin/Hawdesign/packages/creative/src/studio/openai-studio-client.ts) implementing structured completions, circuit breakers, token cost estimation, and image generation using `OPENAI_API_KEY`.
   - Updated [`packages/creative/src/studio/pricing.json`](file:///Users/hawzhin/Hawdesign/packages/creative/src/studio/pricing.json) with official pricing:
     - `gpt-6-astra`: $2.50 input / $10.00 output per 1M tokens.
     - `gpt-image-2.5-sunburst`: $0.04 (1024x1024), $0.08 (1024x1536), $0.16 (2048x2048).
     - Marked legacy models (`claude-fable-5-1`, `claude-opus-5`, `gemini-3-pro-image`) as `disabled: true`.

3. **OpenAI Image Generation Provider**:
   - Updated [`packages/creative/src/studio/gemini-image-provider.ts`](file:///Users/hawzhin/Hawdesign/packages/creative/src/studio/gemini-image-provider.ts) to `OpenAiImageProvider`.
   - Dispatches to OpenAI `gpt-image-2.5-sunburst` for generation and `gpt-6-astra` for visual inspection of calm regions.
   - Rejects non-allowlisted credentials immediately before network dispatch.

4. **Canva Design Planner Migration**:
   - Migrated [`apps/core/src/services/canva-design-planner.ts`](file:///Users/hawzhin/Hawdesign/apps/core/src/services/canva-design-planner.ts) from legacy Claude Opus to `gpt-6-astra`.
   - Generates collision-free vertical layout hierarchy and strict exact-copy preservation.

5. **Design Studio Service & Transfer Fidelity**:
   - Updated [`apps/core/src/services/design-studio/design-studio-service.ts`](file:///Users/hawzhin/Hawdesign/apps/core/src/services/design-studio/design-studio-service.ts) to populate official logo bytes (`kaae-official-logo.png`) into `StageContext` and `manifest`, ensuring Canva PPTX transfer maintains logo fidelity.
   - Wired ledger records and stages to `provider: 'openai'`, `gpt-6-astra`, and `gpt-image-2.5-sunburst`.

6. **Health Probe & Ingress Rehearsal Alignment**:
   - Updated `honestHealthHandler` / `probeModelProvider` in [`apps/core/src/app.ts`](file:///Users/hawzhin/Hawdesign/apps/core/src/app.ts) to probe OpenAI endpoints using `OPENAI_API_KEY` rather than Anthropic.
   - Updated `/ingress/rehearsal` route in `apps/core` to debit `gpt-6-astra` via `CostGovernor`.
   - Added `openai:gpt-6-astra` and `openai:gpt-image-2.5-sunburst` to `pricingRates` in [`packages/integrations/src/cost-governor.ts`](file:///Users/hawzhin/Hawdesign/packages/integrations/src/cost-governor.ts).

7. **Vitest Configuration & Monorepo Test Environment**:
   - Fixed path resolution in [`vitest.config.ts`](file:///Users/hawzhin/Hawdesign/vitest.config.ts) to load `.env.test` relative to repository root (`import.meta.dirname`).
   - Ensured RLS context isolation in `apps/core/test/design-studio-orchestrator.test.ts`.

---

## 2. File-by-File Change Matrix

| File Path | Nature | Purpose / Rationale |
|---|---|---|
| `adrs/030_openai_only_canva_telegram_system.md` | NEW | Normative architectural decision record establishing the strict single-provider policy. |
| `packages/domain/src/provider-policy.ts` | NEW | Strict model and provider allowlist enforcement throwing `DisallowedProviderError`. |
| `packages/domain/test/provider-policy.test.ts` | NEW | Verification tests ensuring disallowed providers fail closed before network access. |
| `packages/creative/src/studio/openai-studio-client.ts` | NEW | OpenAI studio client implementing completions, structured JSON, and image generation. |
| `packages/creative/src/studio/studio-errors.ts` | NEW | Typed error definitions for studio operations. |
| `packages/creative/test/openai-studio-client.test.ts` | NEW | Unit tests verifying OpenAI client serialization, prompt construction, and provider guards. |
| `packages/creative/src/studio/pricing.json` | MODIFY | Added `gpt-6-astra` and `gpt-image-2.5-sunburst`; disabled legacy models. |
| `packages/creative/src/studio/studio-model-client.ts` | MODIFY | Wired pricing and client interfaces for OpenAI. |
| `packages/creative/src/studio/gemini-image-provider.ts` | MODIFY | Converted image generation and vision checks to OpenAI; added fail-closed assertions. |
| `packages/integrations/src/cost-governor.ts` | MODIFY | Added `openai:gpt-6-astra` to rates and default preflight checking. |
| `apps/core/src/services/canva-design-planner.ts` | MODIFY | Updated to `gpt-6-astra` and `OPENAI_API_KEY`. |
| `apps/core/src/services/design-studio/design-studio-service.ts` | MODIFY | Updated to OpenAI provider, populated official logo bytes into context and manifest. |
| `apps/core/src/services/design-studio/types.ts` | MODIFY | Added `logo` buffer to `StageContext`. |
| `apps/core/src/app.ts` | MODIFY | Probed OpenAI endpoint in health check; updated rehearsal route to `gpt-6-astra`. |
| `vitest.config.ts` | MODIFY | Fixed `.env.test` path resolution using `import.meta.dirname`. |
| `MANIFEST.json` & `SHA256SUMS.txt` | MODIFY | Regenerated package cryptographic manifests verifying 525 checks. |

---

## 3. Reversibility & Rollback Policy

No legacy files were deleted destructively. If rollback is required, `adrs/030_openai_only_canva_telegram_system.md` specifies that rather than re-enabling legacy providers in production, the verified snapshot or previous commit can be checked out while preserving queued tasks in PostgreSQL.
