# ADR-237: Sol Judges and Reviews Every Design It Looks At

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/sol-judge-and-visual-review` (from production `e090f9ae`); not deployed. Owner-directed.
**Requirements:** FR-056 (model roles through the registry), FR-057 (owner-directed exception, as ADR-161), FR-040 (bounded repair), FR-038 (QA of what ships), FR-060 (resume without repeating paid work), FR-079 (per-role budgets and caps).
**Changes a foundation:** no. No migration, no new dependency. It adds paid calls per design, which the owner authorised for this change.
**Builds on:** ADR-149 (Sol native image counting), ADR-161 (Sol office primary), ADR-170 (art-directed recipes), ADR-122 (substep replay), ADR-190 (Codex, unreleased: controlled refinement geometry).
**Supersedes:** the 2026-09-20 judge downgrade to `gpt-4.1-mini` (`PRODUCTION_MODELS.judge`), for the reason in section 2.
**Number:** 237, assigned by the lead.

## 1. Context

The owner decided on 2026-10-01: top-quality designs use the top model, `gpt-6.1-sol`, everywhere a model judges or looks at a design.

Production did the opposite:

- Layout, critique and text were on Sol (ADR-161). The judge and the Canva parity check, which resolves the judge role, were on `gpt-4.1-mini`.
- The live K-12 drafts (tasks d34648c9, 407d7f43) made these calls: briefing (Sol), laying_out (Sol), judging ×4 and parity (Mini). No critique or revise call.
- Pipeline v3's critique (`deterministicCritiqueV3`) is measured from hard QA and metrics. It is not written by a model. The gated refinement (`refineCandidateV3`) runs only when a metric or hard QA fails, and production designs almost never fail one.
- So the only model that ever looked at a rendered design was the cheapest one, and it only chose between candidates. Nothing looked at a finished poster and said what a designer would change.

## 2. Decision: the judge and parity move to Sol

`PRODUCTION_MODELS.judge` is `gpt-6.1-sol`. Parity resolves `resolveModel('judge')`, so it moves too. The dev tier (`DEV_MODELS`) is unchanged: `gpt-4.1-mini` judges and critiques there. `HAWA_MODEL_JUDGE` still overrides the role, and `gpt-4.1-mini` stays in `ALLOWED_MODELS` for the dev tier, for an explicit rollback and for verifying historical receipts.

**Why the 2026-09-20 downgrade no longer stands.** That move was measured on agreement, not on design quality. `scripts/experiments/judge-model-agreement.ts` replayed 24 stored comparisons:

- Mini agreed with the old `gpt-6-astra` judge's past verdicts 75% of the time.
- Astra agreed with itself 67% of the time.
- Both caught the degraded canary 12 of 12.

Agreement with an older judge says nothing about which poster is better. The owner's decision is about quality, and the measurement never addressed it.

**Capability, checked on the existing code paths:**

- Sol accepts `image_url` inputs and strict `json_schema` outputs. ADR-149's vision smoke passed two image and schema cases. The brief and layout calls already send Sol images through the same Studio client and ledger.
- Images on Sol are reserved on the provider's own count of the exact inline bytes (`/v1/responses/input_tokens`, policy `studio-sol61-2026-09-30-v2-counted-images`). The judge's renders, the client reference and parity's two PNGs are all inline data URLs, so every one is counted.
- `reasoning_effort` is sent to Sol, as `modelSupportsReasoningEffort` admits it, and `temperature` is not.
- The live trial (section 7) ran 18 Sol judge calls. Every one returned a complete verdict, with 0–89 reasoning tokens and 440–797 output tokens. One real Sol parity call through `runParityStage` (non-strict schema, two inline PNGs) returned a complete verdict.

**What changes in the call, and only for Sol:**

- **Detail.** `judgeImageDetail('gpt-6.1-sol')` is `high`. The native count prices the detail actually sent, so the judge reads the copy at full size and pays exactly for it. Other tile-priced models stay at `low`.
- **Output allowance.** `judgeMaxTokens` gives a reasoning model 6,000 tokens and a non-reasoning model the 2,000 it had. The extra room is for reasoning; a truncated verdict is refused as absent (existing behaviour). The brief-bound challenger gets the same allowance.
- **Budget role.** The judge's calls stay in the `visual_judge` daily budget role (`hawa.studio_budget_role`: `critiquing`, `judging`, `parity`). The office's $30 daily allowance per scope admits about 135–175 designs at the measured rate below. No pricing or reservation policy changed: `gpt-6.1-sol` was already priced (ADR-148/161).

## 3. Decision: Sol looks at the render and returns structured fixes (critique stage)

`packages/creative/src/studio/visual-review-v3.ts`, `reviewCandidateVisuallyV3`. In the v3 critique stage, after the deterministic critique row, the critique role's model reviews the top `HAWA_STUDIO_VISUAL_REVIEW_CANDIDATES` (default 2) candidates that pass hard QA. These are the candidates the judge will choose between.

The model is shown:

- the render the client will see (`previewPng`: art, photos, logo and copy), at `high` detail;
- the same layout with every element's box and mark drawn on it, so a fix can name its element;
- the client's style reference, at `low` detail, when the run has one;
- as data: the requester's words, the brief's occasion, audience, must and mustNot, and the exact copy with roles;
- the client's rules (`promotedRules`: the KAAE guideline's light-first colour usage, ADR-236), the standing client rules and the house art-direction rules;
- every hard-QA defect and finding, and every metric score;
- an element catalogue with each box, size, font, ink and copy.

It returns `{ assessment, fixes[] }` under a strict schema, at most 8 fixes. Each fix has:

- `boxId` (a mark);
- a `category`: hierarchy, spacing, alignment, crop, contrast, whitespace, type_size or grouping;
- a `problem`;
- new values only: `x`, `y`, `width`, `height`, `fontSize`, `lineHeight`, `focusX`, `focusY`, `zoom` and `raiseContrast`, where null keeps a value.

Reasoning effort is `medium` and the output allowance is 12,000 tokens.

Each review is its own substep (`review/candidate-<n>`). The review, its receipt and the exact reviewed layout's SHA-256 are stored as a `critique` judgment (`verdict.kind = 'visual_review'`) and in `stages.critique.visualReview`.

The review runs only when the round count is above zero. It is skipped, at no cost, when no candidate passes hard QA; then the existing gated repair runs in the revise stage, as before.

## 4. Decision: one controlled refinement pass (revise stage)

`applyVisualReviewV3` applies the stored fixes deterministically to the exact layout that was reviewed:

- **Geometry and type size** go through ADR-190's geometry-only patch, `applyRefinementPatch`. `packages/creative/src/studio/refinement-patch.ts` is a byte-identical copy of the file on Codex's unreleased branch (blob `a447c8a6`).
  - Canvas, grid, background, copy identities, fonts, colours, roles, alignment, direction, emphasis and shape identities are protected.
  - A proposal that changes any of them is refused whole, with its findings.
  - Boxes are whole pixels inside the canvas. The logo keeps its aspect.
  - A font size must stay within half to double of the current size and at least 8px. Line height must stay within 0.8–2.5.
- **Contrast is never a colour the model names.** `raiseContrast` picks the brand-palette ink with the most contrast on the block's declared surface.
  - Only ink short of, or within 1.5× of, the house minimum changes.
  - A gold accent line that already reads (8.5:1 against 3:1 needed) keeps its colour. The live trial turned one white before this rule was added (section 7).
- **Photographs never move.** A framed photo's crop (`focus`, `zoom` within 1–3) may change. In a solved recipe, the crop belongs to the solver (ADR-170) and is refused. A cut-out has no crop.
- **Copy is never touched.** A layout carries copy indices, not words. The patch refuses a changed, missing, duplicated or added index, so the grounding rules (ADR-232) stand as they were.

The result then goes through `conformReviewedLayoutV3`:

- fonts (`sanitizeFontsV3`), then the house rules QA checks (`conformToHouseRules`: safe area, leading, the title ladder, the logo's size and clear space, readable brand ink);
- a solved recipe gets its usual fonts-and-palette pass instead;
- not the full first-time preparation, because re-balancing would undo the spacing the review moved.

The result is rendered as the client will see it (`runRenderStage`) and ranked with hard QA on its composite (`rankStudioCandidatesV3`).

## 5. Decision: kept only when better

`decideVisualRefinementV3` keeps the refinement only if hard QA passes. Then one of these must also hold:

- its deterministic measures do not regress: no metric newly failing, the gate not newly failing, and the composite no more than 0.001 lower; or
- the measures did regress, and the judge (`judgeRefinementV3`) prefers the refinement in both presentation orders. This is the incumbent P07 judge with the same brief, rules and reference it selects winners with, ids `original`/`refined`, two calls in its own substep (`review-judge/candidate-<n>-round-<r>`).

A tie, a split verdict or an unavailable judge keeps the original. An adopted refinement is appended to the candidate's `layouts`, so the original stays in the history. Its preview, composite, metrics and score replace the candidate's. The tournament judge then chooses between the (possibly refined) top two as before.

The ranking and the Canva transfer read the candidate's last layout, which is an ordinary `StudioLayoutV2` with the same elements. The design stays editable and transferable: the transfer is tested on a refined layout.

## 6. Bounds, cost, replay

- **Rounds.** `HAWA_STUDIO_VISUAL_REVIEW_ROUNDS` (0–2) sets how many review rounds each candidate gets. The default is 1 on the production tier and 0 on the dev tier, so the dev tier is unchanged. A second round reviews the adopted design again in the revise stage (`review/candidate-<n>-round-2`). FR-040's two-repair bound holds.
- **Hard cap per run.** `HAWA_STUDIO_VISUAL_REVIEW_MAX_USD` (above 0, at most 5; default $1.00).
  - The visual review's calls run inside `inStudioSpendCap`. The paid-call ledger refuses, before admission, any call whose reservation would take the review's spend over the cap. Nothing is sent and no row is written.
  - The ledger charges the actual cost after each call. A retained answer replayed on resume also counts.
  - A provider charge never exceeds its reservation (the ledger holds the run if it does), so the review's actual spend cannot pass the cap.
  - The spend carries from the critique stage to the revise stage in `stages.critique.visualReview.spentUsd`.
  - The run's own budget ($2, 24 calls) and the daily allowances apply as before. A design now makes 8–12 calls before parity.
- **Out-of-range settings** are refused (`VisualReviewSettingsError`), not clamped.
- **Replay safety.**
  - Every call is a named substep, so a resumed stage reads saved answers back without transport (ADR-122).
  - The revise stage applies a review only to a candidate whose current layout hash is the one reviewed. A candidate already refined by an interrupted earlier attempt is left alone (`already_refined`) and no call is made.
  - A hold, a budget stop, an accounting failure or a lost authority stops the run as everywhere else. A model failure or the cap ends the review of that candidate, which keeps its design.

**Cost per design, measured on 2026-10-01** (real models, production tier, `scripts/visual_review_live_trial.ts`, the two briefs of section 7; parity runs only after a Canva export, so it was measured once on its own, through `runParityStage` with the real Sol, on two renders of the text design):

| | before (Mini judge, no review) | after (ADR-237) |
|---|---|---|
| text brief | $0.0755 (6 calls) | $0.1774 (10 calls); first attempt $0.2141 (12 calls) |
| photo brief | $0.0765 (6 calls) | $0.1647 (8 calls) |
| judge, per call | $0.0031–0.0038 (Mini) | $0.0143–0.0198 (Sol) |
| visual review, per candidate | — | $0.0159–0.0214 |
| refinement judge, per pair (only when the measures fell) | — | $0.029–0.031 |
| parity | about $0.003 (Mini, estimated) | $0.0088 (Sol, measured once: 4,203 input tokens of which 3,516 image, 42 output; verdict `match`) |
| **per design, with parity** | **about $0.08** | **about $0.17–0.22** |

The worst case per design is bounded by the review cap ($1.00) plus four Sol judge calls and parity, inside the run's $2 limit.

## 7. Live proof (2026-10-01)

`scripts/visual_review_live_trial.ts` runs Telegram intake, the lifecycle projection and `DesignStudioService` on v3 with the real `gpt-6.1-sol`. It uses a throwaway clone of the test template database and the key the ADR-170 trial uses, read in-process and never printed. No Canva, no Telegram and no production database are touched. Total spend: $0.745, across the two before runs, three after runs (the first text attempt included), two photo attempts that stopped before dispatch at the layout stage (their briefs were paid), and one parity call. Evidence: `plans/sol-visual-review-2026-10-01/LIVE_PROOF.json`. The before/after PNGs are outside the repository, because the photo brief shows client photos.

**Text brief.** The copy of the live KAAE brief: "Quality Assurance Workshop" / "For school principals" / "22 October 2026 · 10:00 AM" / "Divan Hotel, Erbil" / "Seats are limited, please register early".

- **Winner.** Sol said the registration line read as fine print. The fix took it from 18px to 24px, its box from 31px to 40px, and y from 1114 to 1110. The measures held (composite 0.976 → 0.976) and QA passed, so the refinement was kept without a judge call. The refined design won the tournament.
- **Runner-up.** The same fix plus a rule moved to the right edge. The composite fell 0.960 → 0.957, and the Sol judge preferred the original in both orders, so the refinement was discarded.
- **First attempt.** Before the balance sentence was added to the prompt, the review tightened the groups and shortened the card. The judge narrowly preferred it, but it left an empty band under the card. The prompt now asks that a moved group move whole and keep the composition balanced.

**Photo brief.** Task ba4469f2's six-photo album (ADR-170).

- **Winner.** Sol said the subtitle "Field Visit Report" competed with the title (67px against 73px). It was cut to 48px, and the title and body moved to keep the group tight. The composite rose 0.965 → 0.971 and QA passed, so the refinement was kept. That candidate won.
- **Other candidate.** Its subtitle went to 52px. Its gold was also turned white on a contrast request; that is the accent-colour defect fixed in section 4.

## 8. Risks and what is not claimed

- **Self-preference.** Sol now judges and reviews layouts Sol made. The mitigations that already exist stand:
  - order-swapped pairs, where a flip is no verdict;
  - the degraded canary;
  - hard QA and the deterministic measures, which a refinement must pass before any judge is asked;
  - the 2026-09-20 agreement replay can be rerun with Sol as the judge to measure it.
- **No quality study.** Two live briefs show that the stage works and what it changes. They are not a quality study. FR-057's offline corpus, blinded human review and staged canary were not run, as for ADR-161; this is an owner-directed exception.
- **Image count flakiness.** In the same session, the art-direction layout call failed twice before dispatch with "Sol image count unavailable" (ADR-149's count endpoint). Nothing was charged. Earlier and later attempts of the same request counted in 1.8–3.8s. The cause is not known. It is not this change: the layout stage is untouched. It is recorded here because a photo design depends on it.

## 9. Rollback

- `HAWA_MODEL_JUDGE=gpt-4.1-mini` restores the old judge and parity model for a deployment.
- `HAWA_STUDIO_VISUAL_REVIEW_ROUNDS=0` turns the review off, and the gated repair runs as before.
- Neither resumes a run bound to the other model: the substep replay holds a changed model (ADR-161).

## 10. Verification

- **New tests.**
  - `packages/domain/test/sol-judge-routing.test.ts` (4). It failed 2 of 4 on the base.
  - `packages/creative/test/visual-review-v3.test.ts` (19): settings; the judge's detail and allowance; what the review is shown; geometry, type, photo, recipe and contrast rules; copy kept and transferable; the keep/discard guard; the refinement judge on Sol. The accent-colour case was run with the rule disabled, and it failed.
  - `apps/core/test/studio-visual-review.test.ts` (12): parity on Sol and the dev tier on Mini; the review of the top two passing candidates in their own substeps; nothing spent when off or when no candidate passes QA; the cap stops further reviews; a hold propagates; a refinement applied, re-rendered and kept; a QA-breaking refinement discarded without a judge; the judge preferring the original; replay of an already refined candidate makes no call; the cap inside the real ledger (refused unsent with no row; a retained answer charged on replay).
  - The creative and core files cannot load on the base (the modules do not exist).
- **Updated tests.**
  - `judge-tier.test.ts` and `sol61-candidate.test.ts` now pin the new owner decision.
  - `album-report-cover-studio.test.ts` (ADR-142 reservation boundary) pins the judge it was written against and turns the review off, since its subject is the layout call.
- **Full suites** (creative, domain, integrations, worker, core): 466 files, 5524 passed, 5 skipped, 0 failed. `pnpm typecheck` and `pnpm lint` pass.
