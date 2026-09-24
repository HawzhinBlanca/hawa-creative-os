# Pre-registration template for Hawdesign design and systems evaluation

**Status:** protocol to freeze before collecting final human labels. No present result is claimed.

**Designs judged:** exported bytes from the exact Canva revision that would enter review/publication.

**Study unit:** the request/brief lineage, not each judge vote or each generated image.

## 1. Questions and comparisons

1. Does the proposed system produce designs people prefer over the **current `1c1316d` planner** on the same briefs, with equal hard-rule safety?
2. Does it improve verified task completion, revision burden, cost and latency without increasing critical defects?
3. If the office provides comparable human designs, does it meet or beat that **human designer baseline**? This is a separate claim with a separately sealed arm.
4. Which clients, languages, formats or task classes remain weak? No pooled win can hide a critical subgroup failure.

The primary aesthetic estimand is the mean brief-level preference score for proposed versus frozen current planner. For brief `i`, score `s_i = (new_votes + 0.5 × ties) / valid_votes`. The estimate averages `s_i` across sampled briefs with predeclared stratum weights. Resample **briefs**, with all their judges together, for a stratified 95% confidence interval. Report raw votes, tie rate, per-judge results, and the interval. Multiple votes on one brief are correlated and cannot be treated as independent requests.

**Superiority rule:** point estimate at least 0.60 and the two-sided 95% interval's lower endpoint greater than 0.50, with every hard safety gate passed. The human-designer comparison uses the same rule but is reported separately. If the final study is underpowered or inconclusive, say so; do not extend the sample after seeing interim outcomes. A cheaper variant may be admitted only under a separately pre-registered non-inferiority margin and safety equivalence, not by relabeling a failed superiority study.

## 2. Corpus and leakage control

- Inventory at least 200 real or faithfully reconstructed office tasks as the existing model-registry specification requests. Preserve source/task ID, client authorization, campaign lineage, brief and locked copy, required photos/logos, reference, locale, format, and revision history. Never put private content in the public report.
- Freeze `development`, `calibration/power pilot`, and `final sealed holdout` by **campaign/request lineage**. Proposed starting allocation: 80/20/100 briefs if strata and rights permit. A derivative design, sibling format, earlier revision or near-duplicate cannot cross splits. Record a content-hash manifest and duplicate search before sealing. If 200 suitable tasks do not exist, reduce claims rather than fill the final holdout with reused work.
- Target at least three visually different approved clients and coverage of English, Sorani, Arabic, mixed language, square, story and print/landscape as available. Record exact stratum counts. A client or language with too few briefs is described, not certified. Critical Sorani golden cases still require a native reviewer even if the aesthetic study prefers the design.
- The 20-brief KAAE set and any brief used to tune prompts, metrics, thresholds, retrieval or judge selection belong in development only. A sealed holdout is never used to select a model, tweak colors, change archetype weights or recalibrate a defect threshold.
- Use only approved/client-authorized examples for retrieval. Keep negative examples in negative memory. A source's version, hash, consent and approval date are stored alongside labels.

## 3. Study construction and judges

For every brief, provide identical approved copy, assets, references, constraints and output dimensions to each arm. Pin each arm's code SHA, image, prompt, model version, parameters, asset hashes and budget. Run through Canva import/export and the same hard QA. A design that fails hard QA is recorded as a failure; it is not quietly replaced with a hand-picked attempt. Candidate generation count and any repair budget are fixed before the comparison.

Recruit at least three independent qualified judges per brief, with native Sorani literacy for Sorani correctness. Include independent designers and intended requesters where possible, but label requester votes separately if they might recognize their own historical design. The office designer who created a baseline cannot judge that pair. Record conflicts, experience and language competence; do not expose system identity, filenames, metadata, model explanation or metric score. Randomize left/right by a sealed seed and counterbalance order. Give judges the brief and two same-size exports; allow **left, right, no preference, or cannot judge**, plus a short reason and defect tags. No design is retouched for the evaluation unless that edit was part of the fixed production workflow and applied equally to all arms.

Before the final set, use calibration briefs to check whether judges understand the task and to estimate between-brief and between-judge variation. Simulate power at the **brief** level for a meaningful 60/40 effect, considering ties and clustering. Fix the final sample size, inclusion rules, stopping date, analysis code and superiority criterion in the manifest before the first final judgment. If the available 100 briefs are underpowered, acquire more *new* eligible briefs before opening the holdout or accept an inconclusive result.

## 4. Additional endpoints

| Endpoint | Measurement | Admission use |
|---|---|---|
| Critical safety | Independent exact-copy, protected facts, official logo/assets, client scope, permission, source/editability and approval-bound hash checks on the final export. Seeded sabotage cases are separate. | Any observed critical escape blocks promotion. Report numerator/denominator and exact/binomial confidence bound; “0” is not proof of zero future risk. |
| Task fulfillment | Blind reviewers mark each explicit requirement satisfied, missing or unverifiable, with source brief span. | Compare by brief and stratify by task class. Model self-report is not evidence. |
| Visual craft | Pairwise preference plus tagged hierarchy, originality, density, type, crop, cultural fit, accessibility and brand fit. | Aesthetic primary outcome; do not aggregate a good picture over a factual failure. |
| Revision work | Existing ask ledger's verified-done, claimed-but-not-done, unrelated-change rates; rounds and active minutes to approval; manual rescue count. | Same policy in both arms. Report censoring and requests still open. |
| Diversity | Geometry/image archetype clustering on shipped exports, near-duplicate rate within task class, and judge-rated appropriateness. | Diagnostic only: diversity without preference or task-fit gain is not success. |
| Retrieval | Recall@10, nDCG@10, approved-example precision, negative contamination, stale-source rate, cross-client leakage, context size and latency on labels made before candidate runs. | No seeded cross-client hit; improvement must beat lexical-only baseline and justify cost. |
| Machine judge | Sensitivity by seeded defect severity, specificity/false blocks, abstention, position-swap consistency, agreement with individual and consensus human labels. | Cannot override hard QA. Promote only if its decision is useful beyond metrics-only and its error by language is acceptable. |
| Runtime | Stage p50/p95/p99 latency, total task latency, provider/Canva retries, timed-out/unknown outcomes, cost from actual receipts, human minutes, completion without technical rescue. | No unmeasured “optimized” claim. Use production-like load and display per-task distributions. |
| Portability | Supported editable element survival after Canva edit → export → reopen and from cloud-loss reconstruction; unresolved/lost classes. | State the exact supported boundary; no offline lossless claim without evidence. |

The existing `docs/29_ACCEPTANCE_GATES.md` pilot target of at least 100 completed production tasks and at least 95% completion without technical rescue remains a *target*, not an observed fact. Record all eligible requests, failures and withdrawals; do not count only successes. A zero critical escape in 100 tasks has a roughly 3% one-sided 95% upper bound and cannot justify “perfect” reliability.

## 5. Ablations and role selection

Run these on development/calibration, never selecting by final holdout:

- Current planner versus client-specific BrandKit/DesignIntent, with the same model and same candidate budget.
- Creative concept diversification on/off, controlling for candidate count and spend.
- Lexical-only versus client-filtered hybrid retrieval versus reranking, with identical authorized corpus.
- Metrics-only selection, current metric-informed judge, metric-blind judge, and independent-family judge; include left/right swaps and abstention.
- Astra low versus medium effort using the same prompts and long-call transport; compare quality per dollar, p95 latency, completion and unknown billed outcomes. Keep low if medium does not produce a meaningful human gain.
- Final-export hard QA against a frozen seeded defect set: missing/wrong text, Sorani glyph failure, clipping, overlap, logo distortion, wrong client asset, stale approval, altered Canva design, export outage and corrupted file. Measure false refusal on clean samples too.

Model and judge roles use the versioned registry. Each run logs exact model/prompt/schema, request/response IDs where available, input/output hashes, tokens, actual cost, latency, error class and fallback. Unknown cost/outcome is explicitly missing, not zero. Quality, cost and runtime are joint outcomes; price alone never promotes a model.

## 6. Analysis and reproducibility

Predeclare one primary pairwise comparison per claim. Report the brief-clustered interval and effect size; analyze clients, languages and formats descriptively with uncertainty, identifying sample sizes and any strata too small to conclude. Report rater disagreement instead of hiding it in a majority vote. Use a seeded, reproducible analysis script and include the full eligible denominator, exclusions with reasons, missing ratings and unresolved tasks. Do not drop a failed render or a tie from the denominator without the frozen rule saying so.

Store a private immutable evidence bundle: manifest/hash, split and randomization seal, frozen prompts/model configurations, sanitized task IDs, raw votes, baseline/final exports, hard-QA outcomes, provider receipts, statistical script and run output, and reviewer sign-off. The public report may contain only aggregate and rights-cleared examples. Re-running the script on the bundle must reproduce every table and claim. Archive development iterations separately so their results cannot be passed off as final validation.

## 7. Literature and limits

[DesignSense](https://arxiv.org/abs/2602.23438) supplies a human-preference approach specific to graphic layouts. [DesignPref](https://arxiv.org/abs/2511.20513) documents substantial disagreement among professional designers, which is why individual votes and rater variation matter. The [Visual Aesthetic Benchmark](https://arxiv.org/abs/2605.12684) reports that direct comparative judgments can differ from scalar scoring and that model judges trail expert comparison on its tasks. These are external research findings, not measured Hawdesign performance; this protocol tests the local office context directly.
