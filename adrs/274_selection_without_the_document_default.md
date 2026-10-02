# ADR-274: Selection Without the Document Default

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/selection-fixes` (from `claude/design-retarget` @ `e7aebad7`). Not deployed. No paid or live model call was made.
**Requirements:** FR-039 (an independent vision model scores a fixed rubric), FR-017 (authoritative brand identity), FR-013 (the brief carries the request).
**Changes a foundation:** no. No migration, no dependency, no new model role. The judge makes more calls for a client with poster rules (section 4).
**Amends:**
- ADR-238 section 11, on the guideline prior and the guideline pair;
- ADR-271 section 4, on selection and the fidelity rule.

## 1. Context

On 2026-10-02 the owner approved item 4 of the design plan. The evidence came from three documents in `output/research/2026-10-02-design-and-app-ratings/`:
- `DESIGN_PIPELINE_AUDIT.md`: section 1.1 rows d, e and i; section 1.2 items 3 to 6; section 4 items 2 and 4;
- `DESIGN_10_RESEARCH.md`: section 5, lever 6;
- `BLIND_PANEL_RESULTS.txt`.

Together they show that for KAAE the guideline's document page won whenever the selection machinery was unsure. The blind panel scored the shipped document pages 3.6 out of 10. It scored the ADR-271 posters 5.2 to 6.0 and the office's own posts 5.6. Five mechanisms favoured the document page:

1. **A photo concept was replaced.** `art-direction/generate.ts` replaced one of the model's photo concepts with the guideline's document page. `solver.ts` `fadeToPaper` sent any concept on a white page to that page, with the photo in a rounded card. It never faded the photo into white, as the office's Call for Peer Evaluators post does.
2. **The pair was forced and the prior favoured it.** `guidelinePair` put the composed page into the judged pair. On a split or failed judge, `guidelinePrior` then chose it "because it is composed from its page grammar". The judge chose by position in 2 of 5 live trials.
3. **Only two candidates were judged.** The judge saw the top two by a deterministic composite. Every composed poster fails `gridAppropriateness`, and the composites differed by only 0.001 to 0.013. Which posters reached the judge was therefore close to noise.
4. **The judge was anchored to document metrics.**
   - It was told: "Deterministic layout metrics are provided as objective facts. You must take them into account."
   - Its composition dimension counted negative space as a virtue.
   - It never saw an office post.
5. **The fidelity rule counted the office's techniques against a poster.**
   - It counted the office's own dark title tab against a design ("a flat dark panel on the gradient cover").
   - It counted the office's display face: any face other than Crimson Pro or Inter.
   - It counted a missing gold bar on a poster, although most office posts have none.

The owner also made two decisions today:
- KAAE display titles become heavy sans capitals, as in the office's posts.
- Office archive photos will feed text-only posts.

The guideline's serif document page is therefore no longer the preferred look.

## 2. Decision

Each change applies only to a client whose page grammar carries poster rules (`rules.pageGrammar.poster`). Today that is KAAE. A grammar without poster rules behaves exactly as before, and the existing tests pin that behaviour on the same grammar with `poster` removed.

1. **No document-page substitution.**
   - The concept replacement at `art-direction/generate.ts:530` is skipped.
   - `fadeToPaper` (`solver.ts:1486`) no longer diverts to `grammarPage`. On white paper it draws its own band variant: a navy band holding the logo and the title, with the photo fading from the top into the white page.
   - That layout passes validation and production hard QA (`kaae-2025-guideline.test.ts`).
   - The KAAE photo art-direction rule that the art director and the judge read (`kaae-reference.json` `artDirection[1]`) no longer describes the card on a document page as the default.
2. **No forced pair and no composed default.**
   - `guidelinePair` is not used (`pipeline-v3.ts:1992`). Two eligible candidates are judged in rank order.
   - `guidelinePrior` takes `{ posterRules }` (`prior.ts:96`). With it, being composed from the grammar is no longer a reason to prefer a design; only departures from the guideline count.
   - Two guideline-legal designs therefore fall through, in order, to:
     1. the art-direction prior;
     2. the review findings;
     3. the composite.
3. **All three posters are judged in a round robin** (`judgeRoundRobin`, `pipeline-v3.ts:1873`; `POSTER_ROUND_ROBIN_MAX = 3`).
   - Each pair is judged in both presentation orders. A pair the judge decides in both orders counts one win and one loss. A split counts as a tie.
   - The pick is the one candidate with the best score (wins minus losses). When two or more share the best score, there is no pick, and the two leaders go to the tie-break above.
   - The canary is then run on the pick, or on the leader when there is no pick.
   - `WinnerSelectionV3` gains `matches` and `roundRobin`. `match` is the leaders' pair.
   - Core records every pairwise judgment (`design-studio-service.ts:2887`), and records `stages.tournament.roundRobin` and the pick as `judgeWinner`.
   - The challenger protocol (`brief_bound_v1`) is unchanged.
4. **The judge prompt for posters** (`pairwise-judge-v3.ts`):
   - **Metrics rule.** The sentence "Deterministic layout metrics are provided as objective facts. You must take them into account." is replaced by `POSTER_METRICS_RULE` (lines 275 and 303): metrics are facts about legibility and safety only, never about taste, impact or brand fit.
   - **Facts block.** It carries text legibility and type scale only (`posterFactsPrompt`, line 363). It states that the composite, balance, regularity and alignment are withheld, because they were calibrated on document pages.
   - **Composition dimension.** "Negative space" is dropped from it for posters.
   - **Stronger criteria** (`POSTER_IMPACT_CRITERIA`, line 215):
     - impact at feed size counts for more than refinement at full size;
     - a focal point that would stop someone scrolling (a photograph, a bold title or a strong brand element, used big);
     - empty canvas is not a virtue, and density with a clear order is not crowding;
     - brand fit means fit to the request and to the client's own published posts, and a quiet document-page look is not more on-brand than a bold poster in the same palette;
     - the composition criterion now also reaches the photo-brief prompt.
   - **Office reference.** One retrieved office post may be shown as "the standard, not a design to copy" (`officeReference`, line 207). It is attached only when no requester reference takes the judge's image slot.
     - It adds an image to every call, which the existing image slot and cost do not cover. It therefore sits behind `HAWA_JUDGE_OFFICE_REFERENCE`, which is off by default (`officeReferenceForJudge`, `v3.stage.ts:425`).
     - The post is the first exemplar that the run retrieved and pinned (ADR-271 `officePosters`) whose bytes are an office-published post in the client's own exemplar manifest.
   - **Other clients.** Their system prompt and user text are byte-identical: the sha256 at `e7aebad7` is pinned for both the typographic and the photo brief, and the older pin at `051d5606` still holds.
5. **The fidelity rule for posters** (`page-grammar.ts:977`, `:1027`):
   - A dark title tab or panel on the gradient is no longer a departure.
   - Only the guideline's own document page (`composition.grammar === 'page'`) is held to the header rule, the gold bar and the foot rule. A poster without the gold bar is not counted.
   - **Display faces.** The allowed display faces now come from the reference: `poster.displayFonts`, admitted by `page-grammar-admission.ts` and accepted on display blocks (eyebrow, title, subtitle, call to action).
     - KAAE declares `["Inter"]`, the registered heavy sans.
     - When Inter ExtraBold or Black, or another office face, is registered as its own family, it is added there; no code changes.
   - The rule text says the same: "A poster's dark title tab or missing bar is fine." It is 222 characters, within the judge's 240.
6. **A calibration harness, prepared and not run** (`scripts/experiments/judge-calibration.ts`).
   - It runs the poster judge pairwise, in both orders, over the frozen set `plans/judge-calibration-2026-10-02/frozen-set.json`:
     - each of 21 renders against two office posts;
     - each shipped document page against the navy poster for its brief;
     - 47 pairs in all.
   - It reports agreement with the blind panel's labels: the higher mean score, or a tie within 0.5. The report covers:
     - decided agreement;
     - three-way agreement;
     - position consistency;
     - Cohen's kappa;
     - a breakdown by pair kind.
   - Without `--execute`, `OPENAI_API_KEY` and `HAWA_JUDGE_CALIBRATION_APPROVED`, it prints the plan and its cost and sends nothing.
   - One difference from production: an office post has no layout, so no legibility facts are sent for either image.

## 3. Consequences

- A requester can now see the third-ranked composition. In the mocked round robin, the poster ranked third by composite wins both its matches and is selected. Under the old top-two rule the judge never saw it.
- **Ties no longer fall to the document page.**
  - In a mocked three-way cycle where the composed design ranks second, the old guideline pair and prior gave the win to the composed design, "composed from its page grammar".
  - Now the judge makes no pick, the prior sees no difference, and the composite with the findings decides. A person is still asked to choose (`humanChoiceRecommended`).
- For KAAE, the guideline's document page remains one of the compositions offered (ADR-271). It no longer wins by default.
- **Not changed here:**
  - `poster-grammar.ts`, which is the composition work owned by another agent;
  - the thresholds in `design-metrics.ts`, `negative-space-policy.ts`, `layout-metrics.ts` and `hard-qa.ts`, which is the gate calibration owned by another agent;
  - the `bold serif title` sentence in KAAE's `artDirection[7]`, which belongs with the heavy-sans display work;
  - the judge's per-dimension ties (the schema still forbids them; pair-level ties exist).

## 4. Cost: judge calls per design

All figures use the production judge at its measured rate: $0.0143 to $0.0198 a call on `gpt-6.1-sol` (ADR-237).

| Case | Before | After |
|---|---|---|
| Poster client, 3 eligible (KAAE text-only, or 3 photo recipes) | 4 calls (1 pair x 2 orders + canary x 2), $0.057-0.079 | 8 calls (3 pairs x 2 + canary x 2), $0.114-0.158 |
| Poster client, 2 eligible | 4 calls | 4 calls |
| Any other client | 4 calls | 4 calls (byte-identical prompts) |
| With `HAWA_JUDGE_OFFICE_REFERENCE=on` (off by default) | n/a | plus one image per call, about $0.003-0.0036, so $0.024-0.029 more over 8 calls |

**Reservation.** It is unchanged and needed no change:
- every judge call is still reserved individually from its exact request body (`reserveStudioText`) before dispatch;
- the run's limits (default $2 and 24 calls, `newStudioBudget`) hold the extra four calls. A KAAE text-only design was about 10 calls and $0.18-0.22 after ADR-237, and is now about 14 calls and $0.24-0.30.

The orchestrator test `6b` runs both the dev and the production tier through the real ledger. It now makes 8 judge calls and still transfers.

## 5. Proof

**Tests:**
- `packages/creative/test/selection-without-document-default.test.ts` (new, 8):
  - pinned hashes for other clients;
  - the poster metrics rule;
  - no negative space;
  - the strengthened criteria;
  - legibility-only facts;
  - the office reference placement.
- `packages/creative/test/kaae-2025-guideline-selection.test.ts`, with new ADR-274 blocks:
  - the round robin: 8 calls, the third wins, a cycle, shared leaders, a failed canary;
  - the poster deviations, including display faces taken from the reference;
  - the poster prior;
  - the poster rule.
- `packages/creative/test/kaae-2025-guideline.test.ts`:
  - fade on white with poster rules, through validation and hard QA;
  - no `GUIDELINE_PAGE` replacement with poster rules;
  - the old behaviour on a grammar without them.
- `packages/creative/test/judge-calibration-harness.test.ts` (new, 5): the frozen set, the labels, the plan and cost, and the agreement arithmetic.
- `apps/core/test/judge-office-reference.test.ts` (new, 3): the switch is off by default and honours the manifest, the requester reference and poster rules.
- Updated: `apps/core/test/kaae-2025-guideline.test.ts` (the photo report and the stage round robin) and `apps/core/test/design-studio-orchestrator.test.ts` (8 judge calls and 6 pairwise rows).

**Before and after render (deterministic).** These are in the session scratchpad, `sel274/before_guideline_page.png` and `after_fade_on_white.png`:
- before: the K-12 report as the document page, with the photo in a card;
- after: a navy title band, with the photo fading into the white page.

**Open, and needing the owner:**
- The paid calibration run: 94 calls, about $1.34-1.86 at the measured rate. Run it with `HAWA_JUDGE_CALIBRATION_APPROVED` set to the owner's approval.
- Whether to turn on `HAWA_JUDGE_OFFICE_REFERENCE`. Doing so before calibration would change two things at once.
- **KAAE's client-pack profile.** It tells the judge that KAAE's designs use "generous space ... restrained use of its navy and gold". That profile still pulls brand fit toward the document look. It is the owner's text, so it is left unchanged here.
