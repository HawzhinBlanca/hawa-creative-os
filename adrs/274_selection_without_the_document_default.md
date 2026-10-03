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

## Addendum (2026-10-03): the calibration, and the poster vote

**Status:** Implemented on branch `claude/judge-calibration` (from `claude/hunt3-fixes` @ `87f1a981`). Not deployed.
**Owner approval:** the paid calibration (cap US$2.50), then the poster vote and its re-run within the same cap.
**Spent:** $2.18 in all:
- $1.02 for the first run (94 calls);
- $1.07 for the poster-vote run (94 calls);
- $0.09 for the canary check (6 calls).

**Results:** `plans/judge-calibration-2026-10-02/RESULTS.md`.

### A1. What the calibration found

The calibration ran section 2 item 6 with the five equal votes. The "blind panel" is three Claude judges, not people. Human votes are being collected separately.

On the frozen labels:
- decided agreement was 17/29 and kappa 0.21;
- shipped document page vs poster was 5/5;
- our render vs an office post was 12/24, which is chance.

The judge favoured our type-led renders over the office's photo posts 31-6, where the panel favoured the office posts 21-6.

The cause is the vote count:
- Three of the five votes (legibility, typographic craft, hierarchy) are about text.
- None is about imagery or impact, which is what separated the designs most on the panel (imagery: office 5.3, our posters 3.0).
- The judge itself preferred the office post's composition 64 times in 84 calls, and was outvoted 3-2.

### A2. Decision: a poster client is judged on the poster vote

For a client whose page grammar carries poster rules (`posterImpact`, KAAE today), the pairwise judge (`pairwise-judge-v3.ts`) votes on four dimensions.

| Dimension | Weight | What it judges |
|---|---|---|
| `impact` | 2 | The poster at a 300px feed thumbnail: one dominant moment, and the order from it. It absorbs hierarchy. |
| `imagery` | 2 | The visual idea: a relevant photograph, illustration or graphic idea used big. Template ornaments are not one. On a photo brief, ADR-170's art-direction criteria are judged here, and the checklist is still recorded. |
| `composition` | 2 | The whole canvas, with the type craft inside it. Empty canvas is not a virtue. |
| `brand_fit` | 1 | The request, and the client's own published posts. |

**The count.**
- The weights total 7, so there is never a tie, and 4 win.
- Impact and imagery together decide a pair.
- Text has no vote of its own.

**Legibility is a gate, not a vote** (`POSTER_LEGIBILITY_GATE`, `legibilityGate` in the schema, placed first):
- For each candidate the judge states whether essential copy (title, date, place, call to action) cannot be read at full size: too small, too faint, cut off, overlapped, garbled, or on a busy photo with no plate.
- A candidate found illegible loses to one that is not, whatever the votes.
- If both or neither are illegible, the votes decide.
- A reply without the gate is refused like a missing dimension.

**Implementation.**
- `judgeVoteSpec` gives each call its dimensions, weights and schema, and `tallyJudgeVotes` counts the reply. Production and the calibration harness share both.
- `POSTER_IMPACT_CRITERIA` is replaced by `POSTER_DIMENSION_CRITERIA`.
- Each order records `posterVote`, `weights`, the weighted totals, `legibilityGate` and `legibilityVeto`, and Core stores them with the judgment.
- `votes` and `rationales` are now `Partial<Record<AnyJudgeDimension, ...>>`.

**Unchanged.**
- **Other clients:** their system prompts, user text and schema are byte-identical. The sha256 pins at `e7aebad7` and `051d5606` still pass, and the five equal votes and the photo brief's six weighted votes are as before.
- **The call count:** a KAAE design is still 8 judge calls with three candidates and 4 with two. The output allowance is the same.
- **The cost per call:**
  - On the calibration images it rose from $0.0108 to $0.0114: the prompt is longer and the gate's two reasons are added.
  - In production format (1080 PNGs, legibility facts) it was $0.0151-0.0158 on the canary check, inside ADR-237's $0.0143-0.0198.

### A3. The re-run (same frozen set, same images)

| | Five votes | Poster vote |
|---|---|---|
| Decided agreement, round 1 (the frozen labels) | 17/29 (58.6%) | **27/30 (90.0%)** |
| Decided agreement, round 2 | 23/31 (74.2%) | 24/31 (77.4%) |
| Decided agreement, all six panel scores | 19/30 (63.3%) | 27/32 (84.4%) |
| Three-way agreement, round 1 | 19/47 | 28/47 |
| Kappa: round 1 / round 2 / all six | 0.21 / 0.32 / 0.24 | 0.22 / 0.17 / 0.28 |
| Our render vs office post, decided, round 1 | 12/24 (50%) | **22/25 (88%)** |
| Our render vs office post, decided, all six | 14/25 | 22/27 (81.5%) |
| Document page vs poster | 5/5 | 5/5 |
| Pairs where the verdict flips with order | 5/47 | **3/47** |
| Design shown first wins | 44/94 | 48/94 |
| Clear pairs (a full panel point apart), decided | 15/20 | 21/21 |
| Judge verdicts, our render vs office: ours / office / tie | 31 / 6 / 5 | 6 / 33 / 3 |

**Dimension agreement.** On pairs the panel separates on that dimension, each poster dimension agrees with the panel's matching score:
- imagery 89/90;
- impact 68/74;
- composition 53/66;
- brand fit 43/78. Brand fit still sides with our renders 53 times in 84 calls; the KAAE profile and the guideline rule pull it.

**The gate.** It fired 8 times, every time on the broken office post d08 (a panel covering its title). The votes agreed every time.

**Canary.** Three composed KAAE posters (navy, cream and band, English and Sorani) each beat their degraded canary 7-0 in both orders (`scripts/experiments/poster-vote-canary.ts`, `canary-poster-vote.json`). The judge would therefore not be marked unreliable on every pick.

### A4. Reading it honestly, and the recommendation

By the bar set for this change, agreement on our render vs an office post rose clearly above 50%: 88% decided, against 50%. Order flips fell and the canary still fails. So the poster vote is kept, not reverted.

Three caveats stop this short of a calibrated judge:
1. **Kappa did not improve** (0.22 vs 0.21 on round 1). The judge now decides 14 of the 15 panel ties, 13 of them for the office post.
2. **It roughly matches a constant rule.** "The office post always wins" gets 21/27 of the round-1 decided pairs; the poster vote gets 22/27. Without the broken post d08, the constant rule gets 21/23 and the poster vote 18/23. The change removed a structural bias toward type and replaced it with the panel's group-level preference for a used photograph. It does not show fine discrimination between near-equal designs.
3. **The selection that matters in production is not measured.** That selection is between our own candidates for one brief, all text-only or all photo. The frozen set holds only five such pairs, and they are gross.

Two caveats from the first run still hold:
- The ground truth is an AI panel that agrees with itself on 32 of 47 labels.
- Human votes are the real test.

**Next:**
1. Rescore against the human votes when they arrive. The cache makes both runs free to replay.
2. Build a frozen set of pairs within our own candidates, such as the poster variants for one brief, before relying on the round robin's pick between close designs.
3. Keep `humanChoiceRecommended` on ties.
4. Keep `HAWA_JUDGE_OFFICE_REFERENCE` off: it was not tested.
