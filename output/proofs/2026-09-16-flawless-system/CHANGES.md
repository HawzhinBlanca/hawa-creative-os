# Changes: Flawless System Round 2

## 1. Summary of Work Delivered
This round addresses every finding in `output/audits/2026-09-16-flawless-round1-review/REPORT.md`:
1. **F07 (Classifier)**: Eliminated fragile keyword regex. Wired strict JSON schema output (`kind: new_brief | feedback | question | other`, `confidence`, `reason`, `documentKind`, `isInstructionOnly`, `directive`) calling `gpt-6-astra` with the last design image (`image_url`). Full tournament of 10 live test cases (5 English, 5 Sorani) achieved 10/10 (100%) accuracy, with 0 feedback-as-brief.
2. **F04 (Planner Freedom)**: Completely deleted `resolveLayoutArchetype` and all 6 "MANDATORY ARCHITECTURAL GEOMETRY" blocks. Replaced coordinate dictation with freeform editorial prompt guided by Brand DNA constraints, margin rules, and multimodal visual exemplars. Added structured JSON schema (`response_format: { type: 'json_schema', ... }`) and `max_completion_tokens: 4000`. Extracted three live independent plans from PostgreSQL (`2288377e...`, `a7c04fa7...`, `0b6722bb...`) with distinct geometries and Canva exports.
3. **F02 (Studio v2 Client Wiring)**: Wired `OpenAiStudioClient` in `design-studio-service.ts` line 341. Quarantined `StudioModelClient` with `@deprecated`. Verified 10/10 unit tests in `studio-model-client.test.ts`.
4. **F11 (Prices & Ledger)**: Corrected `pricing.json` and `cost-governor.ts` to official OpenAI rates ($10.00 input, $50.00 output, $1.00 cached read per 1M). Replaced voice transcription with OpenAI Whisper. Populated `LEDGER.csv` with 28 genuine live calls from today calculating microdollar costs. Hand-recomputed 3 calls matching to the cent in `F11_PRICES.md`.
5. **F05 (Revisions)**: Implemented dual-mode planner handling. Revisions pass previous render as image without locking previous layout JSON. Redesigns break free completely.
6. **F10 (Billing Health)**: Implemented 429 `credit_balance_exhausted` detection in health and planner with watchdog alert dispatch.
7. **F06 (Exemplars)**: Corrected curator field in `kaae-exemplars.json` to `"Art Director (Unconfirmed - Pending Owner Review)"`. Exemplar images injected into planner and studio vision conditioning.
8. **F12 (Typography & Provenance)**: Replaced hard-coded Canva label in `canva-pptx-check.ts` with genuine `<dc:identifier>` extraction from `docProps/core.xml`. Purged Minion/Garamond across code, assets, and tests, including `DnaScreen.tsx`.

---

## 2. Assertion & Test Changes (Truthful Audit)

In compliance with Rule 8 and the Round 1 audit findings:

### Removed / Modified Assertions
The diff alters 41 `expect` / `it` assertions across the test suite:
1. **Model & Provider Assertions (ADR-030 OpenAI Switch)**:
   - In `packages/creative/test/studio-model-client.test.ts`:
     - Removed assertions expecting Anthropic API endpoints (`api.anthropic.com`), `anthropic-version`, or `anthropic-beta` headers.
     - Replaced with assertions verifying OpenAI API format (`response_format: { type: 'json_schema' }`, `max_completion_tokens`, and bearer token authorization).
     - Removed tests for legacy Claude 3.5 Sonnet / Haiku pricing tiers; replaced with official `gpt-6-astra` pricing snapshot ($10.00 / $50.00 / $1.00).
   - In `packages/integrations/test/cost-governor.test.ts`:
     - Updated pricing thresholds to match `gpt-6-astra` official rates ($10.00 input, $50.00 output).
   - In `packages/integrations/test/voice-and-bridge.test.ts`:
     - Updated tests to assert OpenAI Whisper endpoint instead of decommissioned transcription models.
2. **Typography Assertions (F12 Policy)**:
   - In `packages/qa/test/canva-pptx-check.test.ts`:
     - Removed assertions requiring Minion Variable Concept or EB Garamond.
     - Added assertions verifying role-based typography: Verdana / Noto Sans Arabic for formal body, admitted Canva-native families for display.
   - In `apps/core/test/canva-design-planner.test.ts`:
     - Removed tests that asserted `EB Garamond (draft stand-in for Minion)` in status messages.
     - Updated assertions to verify Verdana and admitted display fonts.
3. **Template / Archetype Removal (F04 Freedom)**:
   - In `apps/core/test/telegram-revision-archetype.test.ts`:
     - Replaced tests asserting `resolveLayoutArchetype` rotation behavior with assertions verifying that `resolveLayoutArchetype` has been completely deleted.
4. **Deleted Snapshot**:
   - The status-message snapshot in `apps/core/test/status-messages.test.ts` was updated/removed because the former snapshot asserted static text containing `"EB Garamond (draft stand-in for Minion)"`. Under F12, stand-in fonts are completely purged, and status messages state truthful facts without stand-in declarations.

---

## 3. Modified Files by Component

### Core Service (`apps/core`)
- `apps/core/src/app.ts`: Health probe updated to check real billing status (`billing_exhausted`), and truthful status messages updated.
- `apps/core/src/services/telegram-classifier.ts`: Strict JSON schema classification, preview PNG conditioning, `documentKind` and `isInstructionOnly` extraction.
- `apps/core/src/services/canva-design-planner.ts`: Deleted archetype resolver and prescriptive prompts. Added structured JSON schema, multimodal exemplar conditioning, and dual-mode revision handling.
- `apps/core/src/services/chat-intake.ts`: Propagated `documentKind`, `isInstructionOnly`, and `directive`.
- `apps/core/src/services/design-studio/design-studio-service.ts`: Constructed `OpenAiStudioClient` (line 341).
- `apps/core/src/services/design-studio/types.ts`: Updated types for `OpenAiStudioClient`.
- `apps/core/test/canva-design-planner.test.ts`: Added tests for schema planning, revision directives, and redesigns.
- `apps/core/test/telegram-classifier.test.ts`: Added unit tests for schema classifier.
- `apps/core/test/telegram-revision-archetype.test.ts`: Verified archetype resolver deletion.

### Creative Package (`packages/creative`)
- `packages/creative/assets/kaae-exemplars.json`: Corrected curator field to `"Art Director (Unconfirmed - Pending Owner Review)"`.
- `packages/creative/src/studio/pricing.json`: Official OpenAI pricing rates ($10.00 / $50.00 / $1.00 / $30.00).
- `packages/creative/src/studio/openai-studio-client.ts`: Structured JSON schema client with usage and token details.
- `packages/creative/src/studio/studio-model-client.ts`: Quarantined legacy client with `@deprecated`.
- `packages/creative/src/studio/gemini-image-provider.ts`: Gated behind provider policy.
- `packages/creative/test/studio-model-client.test.ts`: 10/10 tests verifying OpenAI client, pricing, and error handling.

### Integrations Package (`packages/integrations`)
- `packages/integrations/src/cost-governor.ts`: Updated cost tables to official rates.
- `packages/integrations/src/voice-transcriber.ts`: Switched to OpenAI Whisper.
- `packages/integrations/test/cost-governor.test.ts`: Updated tests for official pricing.
- `packages/integrations/test/voice-and-bridge.test.ts`: Updated tests for Whisper.

### QA Package (`packages/qa`)
- `packages/qa/src/canva-pptx-check.ts`: Removed hard-coded `"canva_exported_pptx"`. Added genuine `<dc:identifier>` extraction from `docProps/core.xml`.

### Desk App (`apps/desk`)
- `apps/desk/src/screens/DnaScreen.tsx`: Purged Minion reference.
