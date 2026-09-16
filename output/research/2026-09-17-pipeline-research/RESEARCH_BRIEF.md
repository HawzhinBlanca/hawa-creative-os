# What the research says about building this pipeline (read 2026-09-17)

Question asked: is the concept-first plan the best way, or have researchers found better algorithms,
tricks and architectures for a lean, high-end design pipeline?

**Answer: the plan I wrote on 09-16 had the order wrong.** The state of the art generates the editable
layout first and paints the background afterwards, conditioned on that layout. My plan generated a flat
picture first and rebuilt it as layers afterwards. The research order is cheaper, has fewer stages, and
removes the "approved a picture, got something different" problem entirely. Nine other findings below
change specific stages. Everything here was read today; numbers are the papers' own.

## 1. The finding that reorders the pipeline

**CreatiPoster** (arXiv 2506.10890, the paper already cited in ADR-029) uses two models: a *protocol
model* that emits a JSON specification of every layer (text or asset, with layout, hierarchy, content
and style) plus a short background prompt, and a *conditional background model* that paints the
background **conditioned on the rendered foreground layers**. Text never enters the image. It reports
beating both open-source approaches and proprietary commercial systems.

Consequence for us: the requester should see a real render of the actual editable layout, with real
generated art behind it, not a throwaway picture. The preview then *is* the deliverable, so the parity
stage I specified yesterday becomes unnecessary, and the money spent on concept boards is no longer
spent twice.

**DesignAsCode** (2602.17690) reaches the same conclusion from the other side: represent the design as
code or a DSL and add "visual-aware reflection", to get structural editability and visual fidelity at
once. Our Layout DSL v2 is already this shape.

**PosterLLaVa** (2406.02884) confirms the output format: normalised bounding boxes in JSON,
`[left, top, right, bottom]` in 0–1, text kept as native content. It reports constraint violation of
11.56% against 41.30% for LayoutPrompter, and image FID 35.97 against 96.86.

## 2. Deterministic metrics replace most judge calls

**Evaluation Metrics for Automated Typographic Poster Generation** (2402.06945) gives ten computable
metrics with formulas: text legibility, grid appropriateness, alignment (80% width variance plus 20%
line uniformity, via A/(A+d) with A=10), balance (B = 1 − [((wx−cx/w)² + (wy−cy/h)²)/2]^0.5),
justification, regularity, typeface pairing, negative-space fraction, and two semantic-significance
metrics. All are pure code, no model call.

This is the largest combined quality and cost win available to us: the things a judge is worst at
(precise spatial and typographic facts) are exactly the things these formulas measure exactly and for
free. Caveat: they were designed for posters with short text, so thresholds must be calibrated against
our own confirmed exemplars rather than adopted at the paper's defaults.

## 3. Retrieval of exemplars, and how much is enough

**RALF** (2311.13602) retrieves K=16 nearest-neighbour layouts using **DreamSim** image similarity
(chosen over LPIPS, CLIP, saliency and random), feeding them through cross-attention. Results: FID 3.45
against 13.59 for the same model without retrieval, and a model trained on 3,000 samples with retrieval
beat the same model trained on 7,734 without. The ablation matters most for us: **retrieval helps
significantly even at K=1**, and improves moderately as K grows. We have twelve exemplars, so top-3 is
both our practical ceiling and, per this ablation, enough to get most of the benefit.

**CAL-RAG** (2506.21934) is the agentic version and the closest published architecture to ours:
CLIP-retrieve similar layout-image pairs, an LLM layout recommender minimising an overlap/alignment/
margin cost, a vision-language grader scoring colour cohesion, spacing, visibility and composition
against thresholds, and a feedback agent restricted to placement, alignment, proportions and
whitespace — explicitly *not* colour or content. Overlap improved 36%, alignment 44%. Its ablation says
retrieval alone gives modest gains and the grader-plus-feedback loop is what actually delivers.

## 4. Refine the winner rather than generating more candidates

Compute-matched, **iterative refinement beats parallel best-of-N** for compositional image generation:
+16.9% on ConceptMix, +13.8% on T2I-CompBench, and human evaluators preferred it 58.7% to 41.3%.

But refinement must be **gated**. "Two Calls Beat Five Agents" (2607.26922) found a five-role pipeline
(Refiner, Planner, Worker, Checker, Judge) lost to a two-call self-refine, and that *ungated* refinement
actively harmed near-ceiling outputs: 66.5% ungated against 95.1% gated on the same task. Its headline
lesson is that "communication format, rather than architecture, is the key factor" and that
implementation details beat architectural complexity. One caveat I will not overstate: its JSON-format
failure was measured on sub-10B local models and does not transfer to frontier models, where our own
F07 classifier already works correctly with a JSON schema.

Stopping rule from the refinement literature: a fixed maximum, plus a positive-feedback stop, plus
plateau detection (stop when the composite score moves less than about 0.02 between rounds). Models
asked to declare "no further improvement" stop prematurely, so the plateau test must be computed, not
self-reported.

## 5. Make the critic look properly, with marks on the image

**Visual prompting for design critique** (2412.16829) generates critique comments *with bounding boxes
tying each comment to a region*, refining text and boxes together with per-step few-shot examples.
Human experts preferred its critiques and it closed 50% of the gap to human performance on one metric.
Independently, **Set-of-Mark** visual prompting (overlaying numbered marks or boxes) improves VQA by
8–15% and spatial reasoning by 10–11%, with results sensitive to marker design.

For us this is nearly free: our renderer can draw numbered boxes around each element before the critique
call, and the critic can be required to cite a box id in every comment. That both raises spatial
accuracy and makes each comment machine-routable to the element it refers to.

## 6. Judging honestly while we have only one provider

The judge literature is blunt: never use the same model family as generator and judge. Mean pairwise
flip rate is 13.6%, with 28% of questions exceeding a 20% flip rate; pointwise scores and pairwise
verdicts disagree (a response scored 8 can lose to one scored 7); rubrics help only when explicit,
criterion-separated and calibrated, and excessive rubric complexity hurts.

Since Astra is currently our only funded model, the usable mitigation is **Quantifying and Mitigating
Self-Preference Bias** (2604.22891): replace holistic scoring with **pairwise, dimension-wise
comparison** — judge A against B independently on five named dimensions, then take the majority vote.
Measured self-preference bias reduction averaged 31.5%, up to 69.9% on the worst-affected model, with
discriminability preserved, and it needs only a prompt change. Combined with order swapping, the
existing degraded-copy canary, and stating the deterministic metrics as facts before the judge reasons,
that is the best available without a second provider. It reduces the bias; it does not remove it, so a
second-family judge stays the goal when credit allows.

## 7. Cost mechanics worth designing around

- **Cascades**: FrugalGPT-style cheap-first-then-escalate reports 50–98% cost reduction at equal
  quality; escalate when the cheap stage's confidence is below a learned threshold, formally when
  expected benefit exceeds the cost of escalation (2605.06350).
- **OpenAI prompt caching**: the minimum cacheable prefix is 1,024 tokens, growing in 128-token
  increments; cached reads cost 0.1× the input rate, cache writes 1.25×. The prefix must be
  byte-stable — a timestamp or an id inside it destroys the cache.
- **Vision cost**: `detail: "low"` costs a fixed 85 tokens per image regardless of size. Judging and
  critiquing can run at low detail; only a final fidelity check needs more.
- **Free pre-filter**: a CLIP-plus-linear-head aesthetic predictor (the public LAION checkpoint) runs
  locally at no API cost and is good enough to rank or drop candidates before any paid judging. Use it
  as a pre-filter or tie-breaker only: aesthetic predictors generalise poorly across domains.

## 8. How many options, and where the human belongs

Choice-overload research puts the usable range at three to five options, with smaller sets producing
better decision quality, and novices more prone to overload than experts. Three previews is right.

Human-in-the-loop practice is more pointed: put approval at irreversible points only, not early and not
often; a preview must show the rendered effect rather than a description of it; and give three
first-class actions — approve, **edit**, reject — with edit as easy as approve, because the highest-value
interaction is the requester fixing one wrong thing and then approving. My 09-16 plan offered only pick
or redo. Adding cheap one-tap edits ("bigger title", "lighter background", "more space") plus free text
is a direct improvement.

## 9. What the image model may and may not be trusted with

Best-in-class text rendering is about 90% accurate (Ideogram 4, via a dedicated typography module), and
errors persist as misspellings, missing words and extra words; accuracy degrades on strings beyond about
six words and on curved baselines, and holds up on short high-contrast display type. Plausible-looking
digits are the easiest error to miss, so copy needs character-by-character comparison.

Arabic-script layout adds its own hazards independent of the model: cursive joining with four glyph
forms per letter, ligatures, bidirectional runs with embedded Latin names and numbers, numbers running
left-to-right inside right-to-left text, and punctuation whose side depends on surrounding context.

Conclusion, unchanged and now better supported: art layers may be generated; copy may not. Sorani never
goes into an image. A short English display line inside art is tolerable only with a character-exact
check, and is not worth it for institutional work.

## 10. Commercial practice agrees on retrieval

Canva's own Magic Design suggests and adapts ready-made templates to the supplied content, and falls
back to suggesting templates when generation does not work out. That is retrieval-and-fill, the same
principle as RALF and CAL-RAG, shipped at scale.

## Sources

CreatiPoster arXiv 2506.10890 · DesignAsCode 2602.17690 · PosterLLaVa 2406.02884 · typographic metrics
2402.06945 · RALF 2311.13602 · CAL-RAG 2506.21934 · Two Calls Beat Five Agents 2607.26922 · visual
prompting for design critique 2412.16829 · Set-of-Mark visual prompting literature · self-preference
bias 2604.22891 · LLM cascade escalation 2605.06350 · Sketch-to-Layout 2510.27632 · iterative refinement
for compositional image generation · choice-overload meta-analysis (Chernev et al.) · OpenAI prompt
caching and vision pricing documentation · LAION aesthetic predictor · W3C Arabic and Persian layout
requirements · Canva Magic Design documentation.
