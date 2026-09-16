# Research-Grade Design Pipeline — task sheet P01–P10 (2026-09-17)

**Supersedes** `output/plans/2026-09-16-concept-first/GEMINI_TASK_SHEET.md` (C01–C08). That sheet had
the stage order wrong; see `output/research/2026-09-17-pipeline-research/RESEARCH_BRIEF.md`, section 1.
Do not implement C01–C08.

**Branch** `studio-v2`. **All rules** from `output/plans/2026-09-16-flawless-system/GEMINI_PROMPT.md`
apply unchanged. **Sequencing:** after round-3 items R1–R4 are accepted, R1 (proactive billing probe)
first. **ADR:** write ADR-031 in `Proposed` status describing this pipeline; do not mark ADR-029
superseded — this refines it.

## 0. The pipeline

```
brief ─► P02 retrieve top-3 exemplars (local embedding, free)
      ─► P03 one Astra call → 3 deliberately distinct layouts (JSON, cached prefix)
      ─► P01 deterministic metrics on all 3 (free) ─► drop or repair failures
      ─► P04 art layer only where the layout asks for it, conditioned on the layout's calm region
      ─► P05 local render + numbered element boxes ─► one critique call citing box ids
      ─► P06 refine ONLY candidates that fail a gate (max 2 rounds, plateau stop)
      ─► P07 pairwise dimension-wise judge with order swap + canary (only if 2+ survive)
      ─► P08 three real renders to Telegram: approve / edit / reject
      ─► existing transfer, Canva import, copy+font+logo checks, approval on the editable draft
```

Order matters and is the core correction: **the editable layout is generated first and the art is
painted afterwards, conditioned on it** (CreatiPoster, 2506.10890). Nothing flat is ever built to be
rebuilt, so there is no parity stage.

## 1. Tasks

### P01 — Deterministic design metrics (do this first; it is the free gate)
**Do:** new module `packages/creative/src/studio/design-metrics.ts` implementing the ten metrics from
arXiv 2402.06945 over a `StudioLayoutV2`: text legibility, grid appropriateness, alignment (80% width
variance + 20% line uniformity, A/(A+d), A=10), balance (B = 1 − [((wx−cx/w)² + (wy−cy/h)²)/2]^0.5),
justification, regularity, typeface pairing, negative-space fraction, semantic significance of layout,
semantic significance of typography. Add a composite score and a per-metric pass/fail against
thresholds **calibrated on the six owner-confirmed exemplars**, not the paper's defaults — the paper
targets short-text posters, our institutional briefs carry long body paragraphs. Record the calibration
run. Keep the existing hard-QA checks (contrast, margins, overlap, palette, copy, RTL) as they are; this
module sits in front of them.
Add three more checks beyond the paper's ten:
- **Occlusion** (CGL-GAN lineage): penalise any element overlapping a salient region of the art layer,
  computed from a binarised saliency mask and its minimum bounding rectangle. Zero cost when there is
  no art layer.
- **Type-scale conformance**: the layout declares a base size and a ratio; every text size must lie on
  `base × ratio^n` within ±1 px. Ratios near 1.1 read quiet, near 1.618 read poster-like; the brief's
  formality picks the band.
- **Degeneracy**: flag a candidate whose values have collapsed to schema defaults, and flag a candidate
  set whose three members are near-identical. Strict-mode constrained decoding guarantees the schema and
  not the quality, and models are documented to collapse to safe defaults to satisfy the grammar.

Composite weighting follows LaySPA's measured reward split: layout quality about 0.8, format compliance
about 0.1, similarity to a retrieved exemplar about **0.1 only** — exemplars set the standard, they are
not to be copied.
**Accept when:** the six confirmed exemplars all score in the top band; three known-bad layouts from the
09-15/16 audits (the boxy bilateral grid, a low-contrast candidate, an off-grid layout) each fail the
specific metric they should fail, named in the output; a hand-built degenerate set of three near-identical
layouts is flagged; total runtime under 50 ms per layout; zero model calls.
**Fixture split (added 2026-09-17, after the owner's review — read this before calibrating):** the
positive fixtures are the **six owner-confirmed** exemplars only. The six dropped entries are
**negative** fixtures and must FAIL: the three extracted 16:9 PowerPoint slides (`image16`, `image17`,
`image19`) must fail grid appropriateness for wrong canvas genre, the officials photograph
(`kaae 5 kurdi`) must not be a positive case, and `KAAE_Commences_2026_Cycle_1080x1350.png` must never
be a positive case because **this system generated it** and calibrating on it is circular. Do not assert
a fixture count of twelve, and do not describe the set as "twelve confirmed exemplars".

**Validity, to state plainly in the proof:** computational aesthetic measures correlate with human
judgement at about ρ = 0.68, rising to ρ = 0.74 on structured compositions, which is our case. That is
enough to gate on and not enough to decide by; the owner's blind preference in P10 remains the arbiter.
**Proof:** `P01_METRICS.md` — the calibration table (six exemplars, thirteen metrics), the three
known-bad results, the degeneracy case, timings.

### P02 — Exemplar retrieval
**Do:** embed the six confirmed exemplars once and cache the vectors on disk; at request time retrieve the
top-3 by similarity to the brief's intent (a text-embedding of the brief against exemplar descriptors is
acceptable; prefer an image-similarity embedding if one is already vendored — RALF found DreamSim best,
CLIP acceptable). Pass the three as `image_url` at `detail: "low"` plus their one-line descriptors.
Record which exemplar ids were sent, per call, in the run journal.
**Why top-3:** RALF (2311.13602) shows retrieval helps significantly even at K=1 and improves
moderately with K; six confirmed exemplars is our current pool, so retrieve the best three of six.
**Accept when:** two different briefs retrieve different exemplar sets drawn from all six confirmed
entries (prove the first-three truncation is gone); the ids sent are journaled; the retrieval adds under
100 ms and no API cost; a `pending` entry is never retrieved.
**Proof:** `P02_RETRIEVAL.json` — two briefs, their retrieved ids and scores, timings.
**Owner confirmation is done (2026-09-17).** `packages/creative/assets/kaae-exemplars.json` now holds
**six** owner-confirmed references, with the six rejected ones and the reason for each recorded in
`droppedInReview`. One rejected entry was output from this system's own render script, so **never treat
anything this system produced as a reference**. Use every confirmed entry, not the first three: the
existing `.slice(0, 3)` in `design-studio-service.ts` must be replaced by similarity retrieval over the
full confirmed set.

### P03 — Layout-first candidate generation
**Do:** one `gpt-6-astra` call returning **three deliberately distinct layouts** as
`StudioLayoutV2` JSON, with `response_format` json_schema in **strict mode**, `max_completion_tokens`,
and **no `$defs` in the schema** (it correlates with non-compliance). Normalise coordinates 0–1 in the
schema (PosterLLaVa, 2406.02884) and scale server-side, so retargeting to our five sizes is a reflow
rather than a stretch. Pass **capacity-aware slots**: for each copy block, compute the character
capacity implied by the candidate box geometry and font metrics and give it to the model, so copy is
fitted before anything is rendered instead of overflowing and being repaired later (PosterMELD,
2608.02218). Each layout declares its type-scale base and ratio. The prompt states
constraints and the standard — palette, copy indices, logo, margins, typography policy (F12 roles),
RTL rules, the retrieved exemplars — and **never coordinates, card geometry or content-specific
blocks**. Each layout declares whether it wants an art layer and, if so, its calm region.
**Accept when:** one brief sent three times yields nine layouts, no two structurally identical, none
containing a twin-card block unless the brief asks; every layout passes the schema; body roles carry
Verdana or Noto Sans Arabic per F12 and display roles a family from the admitted list.
**Proof:** `P03_LAYOUTS/` — nine layout JSONs, call ids, token usage including `cached_tokens`.

### P04 — Art layer conditioned on the layout
**Do:** generate art with `gpt-image-2.5-sunburst` **only** for layouts that requested it, and only
after P01 passes. The prompt is derived from the layout: aspect ratio, the calm region that must stay
dark and low-detail, palette hexes, and the existing P7 art suffix rules (no text of any kind, no
emblems, seals, flags, faces). `quality: 'medium'`, `size` from the layout. Store `x-request-id` and
`usage.output_tokens_details.image_tokens`; cost from the token price. Composite behind the text in the
renderer, with the existing scrim, and re-run the composite contrast check from F03 on the result.
**Accept when:** for a layout with a declared calm region, the generated art measured over that region
is darker and lower-variance than over the rest of the canvas; the P01 occlusion metric passes against
the generated art's saliency mask; composite contrast passes; an art failure degrades to a procedural
motif with the status saying so.
**Proof:** `P04_ART/` — two art layers, their layouts, the region measurements, composite contrast
results, receipts.

### P05 — Annotated render and box-grounded critique
**Do:** the renderer gains a debug mode that overlays a numbered box and label on every element
(Set-of-Mark style). One critique call per round receives the annotated render at `detail: "low"`, the
deterministic metric results **stated as facts first**, and must return comments each citing a box id,
json_schema: `{boxId, issue, severity, suggestedFix}`. Restrict the critic's scope to placement,
alignment, proportion, hierarchy and whitespace — **not** colour, not content, not copy (CAL-RAG
restricts its feedback agent the same way).
**Why:** design-critique visual prompting (2412.16829) closed 50% of the gap to human experts; marks
improve spatial reasoning 10–11%.
**Accept when:** on a deliberately misaligned layout the critic names the correct box ids; comments
referencing colour or copy are rejected by the schema or filtered; the call costs under USD 0.10.
**Proof:** `P05_CRITIQUE/` — annotated render PNG, critique JSON, call id, cost.

### P06 — Gated refinement with a plateau stop
**Do:** refine a candidate **only** if it fails a P01 metric or a hard-QA check, or scores below the
calibrated band. Maximum two rounds. Stop early when the composite score improves by less than 0.02
between rounds. Never refine a candidate that already passes everything. Log why each refinement was
or was not run.
**Why:** ungated refinement measured 66.5% against 95.1% gated (2607.26922); compute-matched iterative
refinement beats generating more candidates for visual tasks.
**Accept when:** a passing candidate receives zero refinement calls; a failing one is repaired and the
repair is attributable to the critique comment that triggered it; a candidate that plateaus stops before
the cap, with the reason journaled.
**Proof:** `P06_REFINE.json` — three candidates (passing, repaired, plateaued) with per-round scores,
calls made, and stop reasons.

### P07 — Pairwise dimension-wise judge
**Do:** replace holistic scoring. For each pair, judge A against B **independently on five named
dimensions** (hierarchy, composition, typographic craft, brand fit, legibility), then take the majority
verdict; run both orderings and discard the pair if the two orderings disagree. Deterministic metrics
are supplied as facts before any reasoning. Keep the existing degraded-copy canary: a deliberately
worsened copy of a candidate must lose. Skip the judge entirely when only one candidate survives P01.
**Why:** dimension-wise pairwise comparison cut self-preference bias by 31.5% on average and up to
69.9%, prompt-only, which is the only mitigation available while Astra is both generator and judge
(2604.22891). Order swapping addresses a 13.6% mean flip rate.
**Accept when:** the canary loses in every live run; order-swap disagreement is recorded rather than
silently resolved; one surviving candidate triggers zero judge calls.
**Proof:** `P07_JUDGE.json` — one full tournament with both orderings, per-dimension votes, the canary
result, call ids and costs.

### P08 — Telegram: approve, edit, reject
**Do:** send the three surviving renders (real renders of the real layouts, not flat concepts) as one
media group, captioned as drafts with the copy already exact. Inline buttons: `Use this`, `Edit`,
`None of these`. `Edit` opens three one-tap common fixes derived from the critique — for example
"bigger title", "lighter background", "more space" — plus free text, which routes through the existing
F07 classifier. Buttons carry signed one-time tokens via `TelegramActionTokenService.createToken`
(action `pick_layout`, 24 h). The pick is **non-blocking**: on timeout the highest-judged candidate
proceeds and the message says so. One `None of these` round is allowed.
**Why:** three options is the choice-overload optimum; human-in-the-loop practice says previews must
show the rendered effect and that edit must be as easy as approve, because the highest-value interaction
is fixing one thing and approving.
**Accept when:** the lead picks, edits and rejects from a test chat and all three paths behave; a
replayed token is refused; the timeout path proceeds with a truthful message; texts appear in the
requester's language.
**Proof:** `P08_PICK.md` — journal excerpts for all three paths, the token refusal, the messages as
received.

### P09 — Cost architecture
**Do:** (a) one stable cached prefix of at least 1,024 tokens holding the P0 safety prefix, brand rules,
typography policy, metric definitions and the rubric — **no ids, no timestamps, no per-request text
inside it**; dynamic content goes last. (b) All judging and critique images at `detail: "low"`. (c) The
cascade order is free (P01 metrics) → cheap (one critique call) → expensive (judge only on survivors).
(d) Caps: USD 1.00 per brief for P03–P07, USD 30 per day office-wide; over a cap the run completes with
the best passing candidate and says so. (e) Every paid call in the ledger with cost recomputed from the
F11 price table.
**Accept when:** `cached_tokens` is non-zero from the second call of a run onwards and the lead sees the
discount in the ledger; a brief with no art and one surviving candidate costs under USD 0.25; the
per-brief cap test degrades truthfully.
**Proof:** `P09_COST.md` — a full run's ledger with cached-token lines, the cheap-path run, the cap test.

### P10 — Qualification
**Do:** 20 held-out briefs (10 English, 10 Sorani, five sizes) through the pipeline with the flag on for
a test chat. The **headline metric is Print-Ready Rate** (PosterMELD, 2608.02218): the fraction of
requests passing four deterministic checks — geometric, readability, asset-integrity, and
obvious-factual-error — with editability reported separately. Report PRR honestly whatever it is; the
published comparison point is 81.3% at USD 0.38 per request, and our cost target is lower. Also report:
zero hard-QA escapes, canary won by the good candidate in at least 19 of 20, order-swap consistency at or
above 80%, composite metric mean above the calibrated band, Canva copy and font checks passing in at
least 18 of 20, median cost and wall-clock per brief, and the count of briefs where no two consecutive
drafts shared a skeleton. Then the owner rates blind pairs, new pipeline against the
current planner.
**Accept when:** the table exists with real numbers per brief and the lead reproduces three rows at
random from the journals.
**Proof:** `P10_QUALIFICATION.csv` plus per-brief folders.

### P11 — Adding more references over time (owner requirement, 2026-09-17)
**Do:** make the reference set growable without an engineer. Three entry points, one confirmation gate:
- **Folder drop**: a new file in `data/kaae-graphics/references/` picked up by a script
  (`scripts/add_exemplar.ts`, or extend the existing `ingest_kaae_graphics.ts`) that computes sha256,
  dimensions and aspect ratio, and appends the entry with `status: "pending"`.
- **Telegram**: the art director sends an image with a caption such as "add reference"; the F07
  classifier routes it, and it lands as `status: "pending"` with the sender recorded.
- **Desk**: an upload control that does the same.

Nothing becomes active until the owner confirms it, at which point `status` becomes `"confirmed"` with
the date. Retrieval (P02) reads confirmed entries only. **Hard guard:** refuse to add any file that this
system produced. Check the candidate's sha256 against everything under `output/` and against the known
render and export script destinations, and refuse with an explanation rather than adding it. One of the
original twelve was our own script's output scored as the top reference, which is the failure this guard
exists to prevent. Re-ranking on addition is by the owner's order, not by a model score.
**Accept when:** the lead drops a file into the folder and it appears as `pending` and is not retrieved;
the owner confirms it and it becomes retrievable; an attempt to add a file copied from `output/` is
refused naming the match; the manifest keeps its `droppedInReview` history intact across additions.
**Proof:** `P11_ADD_REFERENCE.md` — the three entry points exercised, the refusal case, and the manifest
before and after.

## 2. What is explicitly out of scope

Flat concept boards as a separate throwaway stage; any text inside generated images; Sorani in images;
approval on anything but the editable Canva draft; changes to the Canva import, export or QA path; the
Canva MCP lane (F13, still owner-blocked); adding agent roles beyond the ones above — the five-role
pipeline lost to two calls in 2607.26922, so do not add a sixth. Note the apparent tension with
PosterGen and PosterMELD, which are multi-agent: the resolution is that their agents mostly perform
deterministic gating and repair routing, which we do in code. Keep model calls few and gates many.
Raster-to-layer decomposition is also out of scope: LaDe (2603.17965) can decompose an image into RGBA
layers but renders text as pixels rather than native type, so it cannot serve editable copy.

## 3. Honest limits to state in DEVIATIONS.md

The metric thresholds are calibrated on the six owner-confirmed exemplars (confirmed 2026-09-17). Six is a small calibration set, so treat the thresholds as provisional and recalibrate as the owner adds references through P11. The
self-preference mitigation reduces judge bias by about a third and does not remove it; a second-family
judge remains preferable once credit exists. Aesthetic predictors, if used as a tie-breaker, generalise
poorly across domains and must never be a gate. The JSON-format warning in 2607.26922 was measured on
sub-10B local models and does not apply to Astra.

## 4. Reporting

Per task: `TASK / STATUS / COMMITS / PROOF / LIVE IDS / DEVIATIONS / WHAT I DID NOT DO`. Ship behind
`DESIGN_PIPELINE_V3=off`; the lead enables it for one test chat, then the office.
