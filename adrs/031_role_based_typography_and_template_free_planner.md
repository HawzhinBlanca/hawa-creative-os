# ADR-031: Role-Based Typography, Template-Free Freeform Planning, Schema Vision Classification, and True-Cost Governance

**Date:** 2026-09-16  
**Status:** Proposed  
**Context / Scope:** Flawless System Specification (`output/plans/2026-09-16-flawless-system/GEMINI_PROMPT.md`)  
**Preceding ADRs:** ADR-030 (Strict OpenAI-Only Policy), ADR-029 (Design Studio v2 Architecture)  

---

## 1. Context & Problem Statement

Production audits on 2026-09-15 and 2026-09-16 identified six critical structural weaknesses in the Telegram-to-Canva production lane:
1. **Template Dictation (F04)**: The layout planner used `resolveLayoutArchetype` to rotate through six fixed archetypes (`bilateral_grid`, `split_panel`, etc.) with prescriptive system prompts dictating geometric coordinates and card arrangements. This prevented true bespoke composition and resulted in repetitive, boxy designs.
2. **Fragile Classification (F07)**: Inbound Telegram messages were classified using regex keywords. A user's feedback sentence ("ithe bakcground is simple and solid...") was misclassified as a new brief, planned as a standalone design, and then caused a subsequent full invitation brief to be misclassified as feedback on that single sentence, failing intake.
3. **Typography Inconsistencies (F12)**: The legacy brand guidelines referenced Minion Variable Concept, which is not available in Canva and caused silent font substitution to Arimo. An interim stand-in (EB Garamond) was incomplete and produced font warnings.
4. **Locked Revisions (F05)**: Revisions forced the previous layout JSON as an assistant constraint, preventing the model from making significant spatial adjustments when requested.
5. **Billing-Blind Health & Pricing Drift (F10, F11)**: System health reported `ok` even when provider quotas were exhausted, and token pricing in `pricing.json` diverged from official OpenAI platform rates.

---

## 2. Architectural Decisions

### 2.1 Role-Based Typography Policy (F12)
- **Formal Documents** (letters, certificates, agendas, programmes):
  - English body text: strictly **Verdana**.
  - Kurdish and Arabic body text: strictly **Noto Sans Arabic**.
- **General Design Text** (headlines, display titles, dates, names on invitations, posters, social graphics):
  - The model and designer are **free** to choose the best Canva-native display typeface per concept from the admitted list (`Cinzel`, `Playfair Display`, `Cairo`, `Plus Jakarta Sans`, `Vazirmatn`, `Inter`, etc.).
- **Total Retirement**: `Minion Variable Concept` and `EB Garamond` are completely purged from code, DSL, prompts, assets, and tests.
- **Genuine Export Provenance**: `checkCanvaPptx` validates native Canva exports by extracting `<dc:identifier>` from `docProps/core.xml` rather than relying on static labels.

### 2.2 Template-Free Freeform Planning (F04)
- Delete `resolveLayoutArchetype` and all hard-coded geometric coordinate prompts.
- Layouts are composed dynamically based on:
  - Brand DNA palette rules and minimum margins (>=70px).
  - Explicit vertical rhythm and conservative wrapping calculations (preventing text collisions).
  - Visual exemplars loaded as multimodal vision context.
  - Strict JSON schema enforcement via `response_format: { type: 'json_schema' }` and `max_completion_tokens: 4000`.

### 2.3 Multimodal Schema Vision Classifier (F07)
- Replaces keyword regexes with a structured schema call to `gpt-6-astra` (`kind: new_brief | feedback | question | other`, `confidence`, `reason`, `documentKind`, `isInstructionOnly`, `directive`).
- The prompt includes the rendered PNG preview of the last active design in the channel (`image_url`).
- When confidence < 0.70, the system initiates a single clarifying question rather than converting ambiguous feedback into a new brief.
- Multi-block structured briefs are protected by intake invariants and cannot be hijacked as revisions.

### 2.4 Dual-Mode Revision Architecture (F05)
- **Incremental Revision**: Passed the previous preview image (`image_url`) and directive with the rule "Change what the feedback asks; keep copy and brand". The previous layout JSON is never passed as an assistant turn.
- **Concept Redesign**: Triggered by keywords ("change the whole design", "different", "fresh", "start over"). Completely breaks free from the previous layout and coordinates, conditioning on confirmed visual exemplars.

### 2.5 Real Studio Client & True-Cost Governance (F02, F10, F11)
- `OpenAiStudioClient` is wired directly into `design-studio-service.ts`; `StudioModelClient` is quarantined with `@deprecated`.
- `pricing.json` and `cost-governor.ts` match official rates ($10.00/1M input, $50.00/1M output, $1.00/1M cached input, $30.00/1M image tokens).
- Health monitors detect HTTP 429 `credit_balance_exhausted` / `insufficient_quota` and report `modelProviderStatus: 'billing_exhausted'`.
- All paid calls are ledgered in `hawa.model_calls` and recorded in `LEDGER.csv`.

---

## 3. Consequences & Verification

- **Positive**: Complete freedom from rigid template rotations; zero font substitutions in Canva; reliable bilingual intake classification; truthful billing visibility.
- **Evidence**:
  - `F07_CLASSIFIER.csv` (10/10 tournament score with live IDs).
  - `F04_THREE_PLANS/` (three structurally distinct plans and Canva exports for an identical brief).
  - `F11_PRICES.md` & `LEDGER.csv` (exact microdollar calculations matching hand recomputations).
  - Clean git tree, `validate_pack.py` PASS=539, 1000 unit tests green.
