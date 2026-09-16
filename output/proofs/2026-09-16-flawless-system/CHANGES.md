# Changes: Task F12 Typography Policy (Role-Based, Retired Fonts Purged)

## Summary
Task F12 implements the owner's corrected typography policy (commit `b410179` in `GEMINI_PROMPT.md`):
1. **Formal documents** (letters, certificates, agendas, programmes): English body text is **Verdana**. Kurdish and Arabic body text is **Noto Sans Arabic**.
2. **General design text** (headlines, titles, display lines, dates, names on invitations, posters, social graphics): Free choice of Canva-native display fonts per concept from the admitted list (`Cinzel`, `Playfair Display`, `Cairo`, `Plus Jakarta Sans`, `Vazirmatn`, `Inter`, etc.).
3. **Total elimination of Minion & EB Garamond**: Purged from code, prompts, DSL defaults, `render-fonts.json`, `editable-transfer.ts`, `transfer-v2.ts`, font checks, status messages in `app.ts`, tests, fixtures, and docs. All private Minion files and EB Garamond binaries deleted.
4. **Intake Classification**: Added `documentKind: 'formal_document' | 'design_piece'` at intake, classified and verified in `canva-design-planner.ts` and `checkCanvaPptx`.

## Assertion Changes
- **Weakened Assertions:** ZERO.
- **Removed Assertions:** ZERO.
- **Strengthened Assertions:**
  - `checkCanvaPptx` upgraded to inspect role-based typography: body roles on formal documents must strictly match Verdana / Noto Sans Arabic; display roles and general design pieces must use an admitted Canva-native font without substitution; any unadmitted font or Canva substitution (e.g. Arimo) fails with `fontPass: false` and logs the offending object.
  - Test suites in `@hawa/qa` and `apps/core` enhanced with positive and negative role-based test cases for formal documents and design pieces.
  - Renderer tests in `@hawa/creative` updated for exact Verdana line wrapping and metric bounds.

## Modified Files by Component

### 1. Configuration & Client Reference Packs
- `packages/creative/assets/kaae-reference.json`: Replaced single `rules.fontFamily` with `rules.typography: { formalBody: { latin: "Verdana", arabic: "Noto Sans Arabic" }, display: { policy: "free", admitted: [...] } }`.
- `config/clients/kaae.dna.json`: Updated typography guidelines to specify Verdana for body copy, Noto Sans Arabic for Sorani/Arabic body copy, and free choice of admitted Canva-native display families (Cinzel, Playfair Display).
- `packages/domain/src/fixtures/kaae-client-dna.ts`: Updated client DNA rules to reflect role-based typography.
- `packages/domain/src/fixtures/aster-client-dna.ts`: Updated Aster DNA typography to modern admitted families.
- `data/kaae-graphics/learned_knowledge.json`: Updated learned typography associations to eliminate retired font references.

### 2. Core Service & Telegram Adapter
- `apps/core/src/app.ts`: Removed outdated status message mentioning retired stand-in fonts; updated to dynamic role-based font declaration.
- `apps/core/src/services/canva-design-planner.ts`: Integrated role-based font assignment based on `documentKind`. Body roles in formal documents receive Verdana (or Noto Sans Arabic for RTL); display roles select admitted Canva-native families per concept.
- `apps/core/src/services/telegram-classifier.ts`: Added `documentKind: 'formal_document' | 'design_piece'` detection logic and prompt schema for `gpt-6-astra`.
- `apps/core/src/services/design-studio/design-studio-service.ts`: Propagated `documentKind` and role-based typography rules across stages.
- `apps/core/src/services/design-studio/stages/layouts.stage.ts`: Updated font resolution for layout generation.
- `apps/core/src/services/design-studio/stages/qa.stage.ts`: Configured QA stage to pass `documentKind` and roles to `checkCanvaPptx`.
- `apps/core/src/services/design-studio/stages/revise.stage.ts`: Preserved role-based typography during revisions.
- `apps/core/src/services/design-studio/stages/transfer.stage.ts`: Passed role-based fonts to PPTX transfer encoding.

### 3. Creative Package & Layout DSL
- `packages/creative/src/studio/render-fonts.json`: Updated font definitions, setting Verdana to exact system font and cataloging admitted families (`Cinzel`, `Playfair Display`, `Cairo`, `Plus Jakarta Sans`, `Vazirmatn`, `Inter`).
- `packages/creative/src/studio/render-layout-v2.ts`: Updated font resolution and exact rendering pipeline for Verdana and admitted display fonts.
- `packages/creative/src/studio/validate-layout-v2.ts`: Enforced role-based font validation and admitted family whitelist.
- `packages/creative/src/studio/transfer-v2.ts`: Updated font encoding for editable Canva PPTX export.
- `packages/creative/src/editable-transfer.ts`: Updated admitted font whitelist to include all Canva-native display fonts and Verdana.
- `packages/creative/src/feedback-miner.ts`: Purged obsolete font keywords.
- `packages/creative/src/kaae-graphics-learning.ts`: Updated typography mining to track admitted Canva display fonts.
- `packages/creative/src/templates/kaae-institutional.template.ts`: Replaced retired fonts across all institutional templates with Verdana (body) and Cinzel/Playfair Display (headlines).
- `packages/creative/src/templates/kaae-certificate.template.ts`: Updated certificate template to use Verdana and Cinzel.
- `packages/creative/src/templates/kaae-announcement.template.ts`: Updated announcement template to use Playfair Display and Verdana.
- `packages/creative/src/templates/kaae-invitation.template.ts`: Updated invitation template to use Playfair Display and Cinzel.
- `packages/creative/assets/fonts/fonts.conf`: Updated fontconfig directory list to resolve system fonts and project fonts.

### 4. QA Package & Canva PPTX Inspector
- `packages/qa/src/canva-pptx-check.ts`: Rewrote inspector to perform full role-based validation:
  - Validates `formalBody` rules on body objects in formal documents (`Verdana` for Latin, `Noto Sans Arabic` for Sorani/Arabic).
  - Validates that display objects and design pieces use families from `admittedFonts`.
  - Flags substituted fonts (e.g. Canva substituting Arimo) or unadmitted fonts with `fontPass: false` and details in `offendingObjects`.
- `packages/qa/test/canva-pptx-check.test.ts`: Added comprehensive test coverage for role-based validation, formal documents, design pieces, Arabic complex script runs, and substitution rejection.

### 5. Deleted Asset Files
- `packages/creative/assets/fonts/CormorantGaramond-Italic.ttf` (DELETED)
- `packages/creative/assets/fonts/CormorantGaramond-SemiBold.ttf` (DELETED)
- `packages/creative/assets/fonts/EBGaramond-Bold.ttf` (DELETED)
- `packages/creative/assets/fonts/EBGaramond-Italic.ttf` (DELETED)
- `packages/creative/assets/fonts/EBGaramond-Regular.ttf` (DELETED)
- `packages/creative/assets/fonts/EBGaramond-SemiBold.ttf` (DELETED)
- `packages/creative/assets/fonts/OFL-EBGaramond.txt` (DELETED)
- All private licensed font directories purged.

### 6. Tests & Scripts
- All unit, integration, and golden tests updated to assert Verdana and admitted display fonts across `apps/core`, `packages/creative`, `packages/domain`, and `packages/qa`.
- Scripts updated to use admitted families and generate verification proofs.
