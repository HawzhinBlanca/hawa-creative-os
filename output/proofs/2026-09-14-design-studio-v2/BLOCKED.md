# Blocker Report: Gemini API Prepayment Credits Depleted (HTTP 429)

- **Date / Timestamp**: 2026-09-14T13:30:00Z (16:30:00 Baghdad)
- **Branch**: `studio-v2`
- **Component**: `@hawa/creative` (`src/studio/gemini-image-provider.ts`)
- **Status**: **BLOCKED — User-Only Action Required**

---

## 1. Description of Blocker

During live probe execution and production container queries to Google Gemini Image API (`gemini-3-pro-image`), the API consistently returns HTTP 429 with error status `RESOURCE_EXHAUSTED`:

```json
{
  "error": {
    "code": 429,
    "message": "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. Learn more at https://ai.google.dev/gemini-api/docs/rate-limits.",
    "status": "RESOURCE_EXHAUSTED"
  }
}
```

This error signifies that the prepaid credit balance for the Google Cloud / AI Studio project tied to `GEMINI_API_KEY` is zero.

---

## 2. Impact on Design Studio v2

1. **Procedural Art Fallback**:
   - The degradation ladder in `generateArtForCandidate()` functions as designed: upon detecting HTTP 429 failures across the configured attempts, it safely falls back to deterministic procedural motifs (`motifs.ts`) with `artFallback: 'procedural'` and $0.00 spend.
   - All text contrast checks, SVG rendering, and layout workflows remain fully functional using procedural motif washes.
2. **Generative Imagery Unavailable**:
   - Until credits are replenished, genuine AI-generated background imagery (`gemini-3-pro-image`) cannot be generated.
   - Task T07 live probe with genuine 2K generated image bytes, dominant color $\Delta E_{2000}$ checks, and zero-shot Fable vision verification will be re-run immediately once credits are restored.

---

## 3. Required User-Only Action

To unblock generative imagery:
1. Navigate to Google AI Studio at `https://aistudio.google.com/` (or `https://ai.studio/projects`).
2. Select the project associated with the Hawa deployment.
3. Under **Billing / Settings**, add prepaid credits to the project account.
4. Once credits are active, notify the agent to execute the live Gemini image generation probe.
