# Merge note for Codex: Sol judge and visual review (ADR-237)

Branch `claude/sol-judge-and-visual-review`, from production `e090f9ae`. Owner-directed on 2026-10-01: top-quality designs use `gpt-6.1-sol` everywhere a model judges or looks at a design. The owner authorised this change in `packages/creative/**` and `apps/core/src/services/design-studio/**`.

I read `origin/codex/research-grade-design-system` first and reused your refinement design where it already existed.

## What is shared with your branch

- **`packages/creative/src/studio/refinement-patch.ts`** is a byte-identical copy of yours (blob `a447c8a6`). On merge, both sides add the same file, so there is no conflict.
  - The visual review applies its fixes through `applyRefinementPatch`, as a geometry proposal against the reviewed layout. Your protected inputs and findings decide what is refused.
  - Your `refinement-engine-v3.ts` changes are untouched here: no edit to that file, nor to `refineCandidateV3` in `pipeline-v3.ts`.
- **One import.** `visual-review-v3.ts` imports `applyRefinementPatch` and `RepairRejection` from `./refinement-patch.js`. If you change that module's API, `applyVisualReviewV3` is its second caller. The call passes `{ palette, allowedFonts }` and no `copyIndices`. The proposal is the reviewed layout itself with only the fixed boxes and type changed, so the identity checks always see the full set.

## Files this branch changes

| File | Change | Overlap with your branch |
|---|---|---|
| `packages/domain/src/provider-policy.ts` | `PRODUCTION_MODELS.judge` = `gpt-6.1-sol`; comments | none on your side |
| `packages/creative/src/studio/pairwise-judge-v3.ts` | `judgeImageDetail` high for Sol; new `judgeMaxTokens` (6,000 for a reasoning model) | none |
| `packages/creative/src/studio/brief-bound-judge.ts` | same output allowance | none |
| `packages/creative/src/studio/visual-review-v3.ts` | new | none |
| `packages/creative/src/studio/refinement-patch.ts` | your file, verbatim | identical |
| `packages/creative/src/index.ts` | one line, `export * from './studio/visual-review-v3.js'`, right after the `refinement-engine-v3` export | you add lines at other places; no hunk overlap |
| `packages/creative/src/studio/JUDGE_ART_DIRECTION.md` | a cost paragraph | none |
| `apps/core/src/services/design-studio/spend-cap.ts` | new | none |
| `apps/core/src/services/design-studio/design-studio-service.ts` | ledger `complete()`: three small hunks (`assertWithinStudioSpendCap`, `chargeStudioSpendCap`); v3 critique stage adds the review after the deterministic row; v3 revise stage gets a branch before the gated repair; imports | check yours with `git merge-tree` (below) |
| `apps/core/src/services/design-studio/stages/v3.stage.ts` | imports; new functions appended at the end (`runVisualReviewStageV3`, `runVisualRefinementStageV3`) | appended only |
| `apps/core/src/services/design-studio/stages/parity.stage.ts` | comment only | none |

`git merge-tree --write-tree origin/codex/research-grade-design-system claude/sol-judge-and-visual-review` was run when this branch was sealed; the result is in the commit message of the seal.

## Behaviour you should know when you merge

1. **The v3 revise stage branches first.** When `stages.critique.visualReview.reviews` is non-empty, the revise stage applies the reviews and returns. The gated `refineCandidateV3` does not run for that run.
   - Reviews exist only when the production tier is active (or `HAWA_STUDIO_VISUAL_REVIEW_ROUNDS` ≥ 1) and some candidate passes hard QA.
   - Otherwise your gated repair runs exactly as before. That includes your ADR-190 rounds and receipts.
   - If you want both, put your gated repair after the visual branch for candidates the review did not cover.
2. **Refinement goes through `conformReviewedLayoutV3`, not `prepareGeneratedLayoutV3`.** That means `sanitizeFontsV3` plus `conformToHouseRules` for a typographic layout, and the recipe's usual pass for a recipe layout.
   - Full preparation re-balances the composition and undid the spacing the review moved.
   - If your branch changes `conformToHouseRules`, or the recipe branch of `prepareGeneratedLayoutV3` (yours adds `applyContentBackground`), the refined layout gets your change automatically.
3. **Keep/discard rule.** Hard QA must pass. Then either the deterministic measures must not regress (no newly failing metric, composite within 0.001), or the incumbent judge must prefer the refinement in both orders (`judgeRefinementV3`, ids `original`/`refined`). Your `compareCandidatesV3` changes (soft hero by finding) do not affect it.
4. **New substeps and a spending cap.**
   - The reviews are substeps `review/candidate-<n>` (stage `critiquing`). The tie-break judge is `review-judge/candidate-<n>-round-<r>` (stage `revising`).
   - The cap is an `AsyncLocalStorage` scope checked by the ledger before admission: `HAWA_STUDIO_VISUAL_REVIEW_MAX_USD`, default $1.
   - Nothing changes for calls outside the scope.
5. **Judge on Sol.**
   - It runs at `high` detail, which the native count prices exactly.
   - It has a 6,000-token output allowance. The live trial ran 18 Sol judge calls; reasoning used at most 89 tokens.
   - Tests on your branch that pin `resolveModel('judge','production') === 'gpt-4.1-mini'` (`packages/domain/test/judge-tier.test.ts`, `sol61-candidate.test.ts`) were updated here.
6. **Contrast.** The review never names a colour. `raiseContrast` picks the most readable brand ink, and only for ink short of, or within 1.5× of, the house minimum.

## Not done here, for you to decide

- Your W5 local optimisation and `refinement-evidence.ts` are not used. Visual-review receipts are stored in `stages.critique.visualReview` and in the `critique` judgment rows (`verdict.kind = 'visual_review'`). Fold them into your evidence shape if you prefer.
- The Desk does not yet show the review's assessment or the before/after layouts. The Desk is yours; the data is in the judgment rows and in `stages.revise.visual.outcomes`.
