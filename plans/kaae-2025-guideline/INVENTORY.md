# KAAE 2025 guideline: where the brand lives (ADR-238)

**Source.** The guideline is "Brand Guidelines — Excellence Edition" (2025), file `KAAE_Guidelines4.pdf`. It is not committed, because it is a client document.

**Withdrawn.** The older "BRAND GUIDLINES.pdf" and every one of its values:

- the colours `#17087A`, `#3833A3`, `#0F73DE`, `#E8B85C`, `#FFF2DB` and `#000000` as the brand's ink;
- `#160874` and `#35309B`;
- the typeface "Minion Variable Concept";
- "indigo" as a KAAE colour.

Stale KAAE values were removed with them: `#C5A059`, `#D4A94C`, `#FFD15C`, `#2D4A73`, `#002050`, `#1A1A1A` as the ink, and Verdana, Cinzel, Playfair Display, Cairo and Noto Naskh Arabic as KAAE fonts.

**Status** is one of:

- **fixed**: done in this branch.
- **handoff**: someone else must act; the step is given.
- **historical, untouched**: a dated record, kept as it was.

**Search.** The inventory was built on 2026-10-01 with `git grep` for KAAE, the client id `c1000000-0000-4000-8000-000000000002`, the old and new values, brand-kit, palette and font words near KAAE, and `canvaMapping`.

## Studio reference, fonts and design code

| Location | What it holds | Status |
|---|---|---|
| `packages/creative/assets/kaae-reference.json` | Palette, fallbacks, brandColors, colorUsage, art-direction rules, logo rules (`logoConstraints`), typography, Sorani note, `pageGrammar` (header, bar, lead, cards, foot rule, cover, elements), source file, edition and pages | fixed |
| `packages/creative/assets/fonts/` + `src/studio/render-fonts.json` | Crimson Pro Regular/Bold/Italic and Inter Italic added (OFL). Crimson Pro and Inter declared. `fonts.conf` symbol list | fixed |
| `packages/creative/assets/elements/*.svg` | The sunburst and triangle mosaic (p.13), as vector assets | fixed (new) |
| `packages/creative/src/studio/page-grammar.ts`, `brand-elements.ts`, `shape-gradient.ts` | Grammar primitives, composer, conform, vector elements, gradients | fixed (new) |
| `layout-v2.ts`, `render-layout-v2.ts`, `transfer-v2.ts` | Gradients, primitives, ornaments, composition. Native `a:gradFill` in the deck | fixed |
| `validate-layout-v2.ts`, `hard-qa.ts`, `composite-contrast.ts`, `design-metrics.ts` | Gradient and ornament palette. ORNAMENT. Client clear-space share. LOGO_CLEAR_SPACE, LOGO_EFFECT and LOGO_BUSY_GROUND. Gradient-aware contrast. Inter as an admitted body face | fixed |
| `art-direction/solver.ts`, `generate.ts`, `tone.ts` | Grammar colours, faces and marks on light recipes. The guideline page (fade_to_paper on white). Tone words: "indigo" dropped, "cover" added, white default paper | fixed |
| `layout-generator-v3.ts`, `pipeline-v3.ts`, `visual-review-v3.ts` | Primitive in the model's schema, grammar in its request. Prepare keeps composed designs and conforms model ones. Review keeps grammar colours | fixed |
| `packages/creative/src/creative-director.ts` | KAAE Sorani headline face (IBM Plex Sans Arabic, p.10) | fixed |
| `packages/creative/src/brand-kits.ts` | KAAE kit: palette, Crimson Pro titles, Inter body, Blue→Midnight cover | fixed |
| `packages/creative/src/kaae-graphics-learning.ts` | Learned palette, fonts and archetype palettes | fixed |
| `packages/creative/src/font-policy.ts` | Reads the registry (no literal KAAE value) | fixed (no change needed) |
| `packages/creative/src/vdp-personalizer.ts` | Generic VDP demo colours, no KAAE identity | historical, untouched (not KAAE's brand) |

## Core services

| Location | Status |
|---|---|
| `apps/core/src/services/client-design-reference.ts`: a DNA logo minimum may be under 100px, down to 16 (the house's 100px still applies in QA) | fixed |
| `apps/core/src/services/design-studio/design-studio-service.ts`: the packaged KAAE reference passes its admitted faces, its logo rules and its page grammar | fixed |
| `stages/layouts.stage.ts`: composed guideline pages and covers, the grammar for the model and the solver | fixed |
| `stages/v3.stage.ts`: client clear-space share in hard QA | fixed |
| `stages/brief.stage.ts`: tone wording | fixed |
| `apps/core/src/services/canva-design-planner.ts`, `saved-design-copy.ts`, inline templates | No literal KAAE values; read the reference or DNA | fixed (no change needed) |
| `packages/qa/src/canva-pptx-check.ts`: the message names the client's required font; Crimson Pro and IBM Plex Sans Arabic admitted | fixed |
| `packages/qa/src/engine.ts`: IBM Plex Sans Arabic admitted for Sorani | fixed |
| `packages/integrations/src/canva-native-adapter.ts`, `historical-design-migrator.ts`: gold `#F7B500`; Sorani faces | fixed |
| `packages/retrieval/src/retrieval-service.ts`: wording ("substitute branding") | fixed |
| Telegram captions and alerts (`apps/worker/src/delivery-notification.ts`, `office-draft-alert.ts`, `telegram-*.ts`) | No brand colours or fonts | fixed (no change needed) |

## DNA config, fixtures and seeds

| Location | Status |
|---|---|
| `packages/domain/src/fixtures/kaae-client-dna.ts`: colours, fonts, logo assets (80px, 16px mark, pp.5-6 bans), layout rules | fixed |
| `config/clients/kaae.dna.json`, `config/clients/kaae.dna.yaml`: brand colours, fonts, layout rules and campaign archetypes remapped; contentHash recomputed with `computeDnaHash` (json `3fdc1659…`, yaml `e2ecfb81…`) | fixed. The empty-file `fileHashes` placeholders in `brand.fonts` predate this change |
| `db/seed.sql`: the KAAE client row only, no brand values | fixed (no change needed) |
| `packages/db/migrations/009_correct_kaae_identity.sql`: a comment naming the old file | historical, untouched (applied migration) |
| **Production Client DNA row** (version 6+) | **handoff to the lead, after deploy:** `bash plans/kaae-2025-guideline/apply-kaae-dna-2025.sh` (dry run), then `--apply`. It replaces colours, fonts, layoutRules, logo rules, brand.colors/fonts/layoutRules and remaps any withdrawn colour, re-approves model consent (ADR-234), and refuses while withdrawn text is left. |
| **Client DNA learning rows in production** (`client-learning.routes.ts` and `feedback-miner.ts` write `kaae.dna.json` and DNA versions) | **handoff:** no SQL on production. The DNA script's version supersedes them, because readers read the active version. Learned rules that still name withdrawn values show in the script's "withdrawn text left" list and must be edited in the payload or the Desk before `--apply`. |

## Canva

| Location | Status |
|---|---|
| `config/clients/kaae.dna.json` `canva` (brandKitId `kAHAK-4ShnQ`; designs `DAHU6ovIEc4`, `DAHU6lCA2Ik`) and the fixture `canvaMapping` (`kit_kaae_2026`) | ids kept: they name Canva objects, not colours |
| **KAAE's Canva brand kit (in the Canva account)** | **handoff to the owner:** set the kit's colours to the nine 2025 colours and its fonts to Crimson Pro (titles) and Inter (body). Upload Crimson Pro if the library lacks it. If a new kit is made, re-run the DNA script with `CANVA_BRAND_KIT_ID=<id>`. Not done here: the Canva connector was not authorised in this session. |

## Desk (apps/desk: Codex's; handoff only, not edited)

| Location | Needed change |
|---|---|
| `apps/desk/index.html:9` | The Google Fonts link loads Cairo and Noto Naskh Arabic. Load Crimson Pro, Inter, IBM Plex Sans Arabic and Noto Sans Arabic instead. |
| `apps/desk/src/services/brandKits.ts` 158-186 | KAAE kit fonts Inter and Cairo: make the title face Crimson Pro and the Sorani face IBM Plex Sans Arabic or Noto Sans Arabic. The palette is already 2025. |
| `apps/desk/public/showcase/index.html:9,19,80,132` | Playfair Display → Crimson Pro; `--kaae-charcoal: #1A1A1A` → `#0A1628`. |
| `apps/desk/public/showcase/kaae_social/post1_*.html:8,88,152`, `post2_*.html:8,71,113`, `post3_*.html:8,72,110,119` | Playfair Display → Crimson Pro. |
| `apps/desk/test/sanitizer.test.ts:39` | `#160874` → `#0A1628`, `#E8B85C` → `#F7B500` (test data). |
| `apps/desk/src/components/StudioPanel.tsx` 522, 670, 813 | `#0A1628` is already 2025 Midnight; no change. |
| `apps/desk/src/screens/DnaScreen.tsx` | Reads the DNA generically; it shows the new row after the DNA script runs. |
| `apps/desk/public/assets/logos/kaae-logo-primary.svg`, `kaae-symbol.svg` | Logo artwork: its colours are the logo itself. Its embedded `font-family` fallback list names the old face. **Do not edit the logo.** Historical, untouched. |

## Evals, testkit, scripts

| Location | Status |
|---|---|
| `packages/evals/src/design-studio/offline-runner.ts`, `judge-experiment.ts` | fixed (2025 palette; Inter) |
| `packages/testkit/chaos/**` (provision, fakes), `packages/testkit/test/r14*`, `three-client-production-pilot.test.ts` | fixed |
| `scripts/**` (21 render and proof scripts) | fixed (colours remapped, Verdana as the KAAE font → Inter) |
| `scripts/kaae_2025_guideline_live_trial.ts` | fixed (new: the ADR-238 live trial) |

## Docs, specs, runbooks

| Location | Status |
|---|---|
| `docs/25_OPERATIONS_RUNBOOK.md` (Sorani face, p.10) | fixed |
| `MASTER_SPEC.md`, numbered docs, `runbooks/`, `prompts/` | State no KAAE colour or font; no change |
| `adrs/236_*` | Marked "Superseded by ADR-238"; text kept (history) |
| `adrs/017, 024, 028, 029, 031` (Minion) | historical, untouched |
| `plans/traceability.csv` | ADR-238 evidence appended. The dated ADR-236 entries are kept as history. |
| `plans/kaae-light-guideline-2026-10-01/` | The DNA script and colours JSON removed (superseded by `plans/kaae-2025-guideline/`). The dated merge note is kept as history. |
| `plans/sol-visual-review-2026-10-01/LIVE_PROOF.json` | historical, untouched (a dated proof) |
| `output/**` (about 327 files mention KAAE; 21 hold old values), `evidence/**` (51; 1) | historical, untouched |

## Detectors (deliberately name withdrawn values)

These name withdrawn values on purpose, to find them:

- `packages/creative/test/kaae-2025-guideline.test.ts` and `apps/core/test/kaae-2025-guideline.test.ts` assert that the withdrawn values are absent;
- `plans/kaae-2025-guideline/apply-kaae-dna-2025.sh` and `kaae-dna-2025.json` list the withdrawn values to remap them or refuse;
- `packages/creative/test/kaae-graphics-learning.test.ts` fails if a withdrawn value returns.
