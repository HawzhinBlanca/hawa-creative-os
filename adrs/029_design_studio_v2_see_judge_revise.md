# ADR-029: Design Studio v2 — multi-concept, see-judge-revise design generation

**Date:** 2026-09-14
**Status:** Accepted for implementation (feature-flagged; qualification gates in `output/plans/2026-09-14-design-studio-v2/`)
**Supersedes:** the single-shot layout planner described in ADR-024/ADR-026 as the *quality* path. The single-shot path stays as the fallback rung of the degradation ladder.

## Context

The admitted automatic draft path (ADR-024, ADR-026, ADR-028) is reliable and honest: exact copy,
brand palette, official logo, editable Canva document, receipts for every paid call, status messages
that never overclaim. It is also visually poor, by construction:

- One model call, text in, rectangles out. The model never sees its own result and gets one attempt.
- The layout language (`EditableTransferPlan`, `packages/creative/src/editable-transfer.ts`) can
  express text boxes, flat rectangles and one logo. It cannot express imagery, gradients, textures,
  rounded panels, rules with weight, opacity or a typographic system.
- No references. Seventy-one KAAE reference graphics sit in `data/kaae-graphics/references/` and are
  never shown to the model.
- No critique, no alternatives, no selection. Human designers make several versions, look, judge and
  revise; the pipeline has zero iterations.
- The prompt asks for "restrained"; it gets restrained.
- The brand typeface (Minion Variable Concept) is not in Canva, so every Latin draft ends in
  `CANVA_FONT_MISMATCH` and is rendered in a substitute (observed 2026-09-14: Arimo).

The user's requirement (2026-09-14) is explicit: research-grade, top-tier design output, every time,
in the same lean structure, with proof.

What the 2026 literature says, as far as it bears on this decision (sources in the task sheet):

- Visual feedback in the loop is the single largest lever for layout quality; text-only and
  code-only generation underperform iterative see-and-fix (Guo et al., *Seeing is Improving*, 2026).
- Frontier models fail at exactly the things a deterministic layer can own: precise spatial
  reasoning, fine typographic perception, structural validity (Graphic-Design-Bench, 2026;
  GraphicWeaver, ALVR 2026). So the model proposes; typed code measures and enforces.
- A layered JSON "protocol" (every layer with position, hierarchy, content, style) plus a separately
  generated background beats end-to-end image generation for editable design and is what the
  strongest published system does (CreatiPoster, 2025/2026). This is the architecture below.
- Multimodal judges are biased: they reward verbose or plausible text over what is in the image
  (informativeness bias, Zou et al., ACL 2026), anchor on narrative over perception (Park et al.,
  2026), and prefer whichever candidate is shown first (position bias, IJCNLP 2025 and the LLM-judge
  surveys). Therefore: the judge sees measured facts first, never sees the designer's rationale,
  every pairwise comparison runs in both orders, and a perturbation canary checks the judge live.

## Decision

Build **Design Studio v2** as a staged, journaled, resumable pipeline behind the existing Canva
path. Same monorepo, same Hono core, same Restate worker, same PostgreSQL with RLS, no new services.

1. **Brief → concepts → layouts → art → local render → critique → revise → tournament → hard QA →
   transfer.** Each stage is a journaled row; each paid call has a receipt; the run is resumable
   after any interruption without a second charge for a completed stage.
2. **Layout DSL v2** (`StudioLayoutV2`): grid metadata, background, optional raster *art layer*
   (generated or procedural) with a contrast scrim, shapes with kind/opacity/radius/rotation/stroke,
   text with role/line-height/letter-spacing, logo. Copy is still placed by `copyIndex` and never
   written by the model. Direction and script typeface for Sorani remain server decisions (ADR-028).
3. **Models.** Planning, critique and judging use the best model reachable by the production key,
   `claude-fable-5-1` (verified 2026-09-14 via the models endpoint), with JSON-schema structured
   outputs and prompt caching on the stable prefix. `claude-opus-5` is the recorded fallback. Imagery
   uses `gemini-3-pro-image` (Nano Banana Pro; verified reachable), text-free, palette-conditioned,
   SynthID-watermarked, with a procedural SVG motif as the no-network fallback.
4. **Deterministic layer owns correctness.** Bounds, overlap, minimum sizes, WCAG 2.2 contrast
   against the effective background, safe margins, grid alignment, hierarchy monotonicity, logo
   aspect and clear space, palette, exact copy, RTL flags — all measured in typed code, all
   hard-fail before any judge opinion. Measured facts are handed to the judge as the first thing it
   reads.
5. **Judge design.** Rubric scoring with evidence anchors; the judge never sees concept rationale;
   pairwise tournament with order swap (disagreement = tie); a live canary (deliberately degraded
   copies must lose) that marks the run `JUDGE_UNRELIABLE` and routes to human review when it fails;
   a final parity check on the real Canva PNG, not the local preview.
6. **Local render is a preview, Canva is ground truth.** Candidates render locally (SVG →
   `rsvg-convert`, already in the core image) with the same font files the final document will use
   where licensed, otherwise a declared stand-in recorded in the manifest. Only the winner is
   imported into Canva. The final judgment is made on the exported Canva PNG.
7. **Flexibility for users.** Tier (`standard`/`premium`), imagery (`auto`/`none`/`generated`),
   number of previews delivered (1–3), hold-for-selection in Desk, and a per-run budget cap. Every
   option is journaled in the request hash.
8. **Learning is governed.** Art-director verdicts (Desk and Telegram) land in an append-only
   `design_feedback` table, feed the promoted-rules list already consumed at intake, extend the
   exemplar set, and produce a judge-versus-human agreement metric in the evaluation harness. No
   fine-tuning, no automatic rule promotion.
9. **Feature flag.** `DESIGN_STUDIO_V2` defaults off. The automatic Telegram path keeps using the
   single-shot planner until the qualification gates in the task sheet pass and the flag is turned
   on by the operator. The explicit `POST /v1/tasks/:taskId/canva/studio` route works regardless of
   the flag for proofs and Desk use.

## Consequences

- Cost per design rises from one call (~$0.05) to roughly 15–30 calls plus up to five images:
  about $1.5 (standard) to $5 (premium) at September 2026 list prices, bounded by
  `DESIGN_STUDIO_MAX_USD`. Latency rises from ~40 s to 2–6 minutes. Both are recorded per run.
- Brand typeface parity requires a user action: upload Minion Variable Concept to the Canva Brand
  Kit, or declare a Canva-available draft typeface in the reference pack. Until then the manifest and
  status message say which typeface the draft is actually set in.
- The exemplar set must be curated by the art director (rights and taste); the pipeline proposes,
  the human confirms.
- The judge is a component with a measured error rate, never an approver. Human approval remains
  the release gate (ADR-022, Gate F).

## Not decided here

Canva Autofill/brand-template generation (Enterprise-only per Canva docs, 2026-09-14) is out of
scope. Any change of durable engine, database, or a second editor is out of scope (ADR-020/021).

## Implementation notes (2026-09-14)

The Design Studio v2 pipeline described in this ADR has been implemented and qualified across Tasks T00 through T16:

1. **Pipeline & Stages (`packages/creative/src/studio/stages/`)**:
   - `plan`: Multi-candidate compositional exploration (3 candidates) with structured JSON schemas and prompt cache optimization.
   - `art`: Text-free raster background generation using Gemini 3 Pro (`gemini-3-pro-image`, Nano Banana Pro) with SynthID and $\Delta E2000$ palette validation, falling back gracefully to procedural SVG motifs (`motifs.ts`) upon provider outage or missing credentials.
   - `render`: Multi-script composite preview rendering via SVG and `rsvg-convert` with Fontkit HarfBuzz-grade Arabic/Sorani shaping and line wrapping.
   - `critique`: Vision critique measuring craft, typography, contrast, and layout balance using `claude-fable-5-1` (with `claude-opus-5` fallback).
   - `revise`: Targeted repair of critique defect vectors (e.g. scrim adjustment, element repositioning) while keeping brief facts and copy strictly immutable.
   - `tournament`: Pairwise head-to-head evaluation with presentation order swap to cancel position bias (disagreements result in ties).
   - `canary`: Live adversarial degradation test (e.g. 40% font shrinkage, logo collision) requiring the candidate to beat degraded clones; failure marks `judgeStatus: 'UNRELIABLE'` and falls back to deterministic metrics.
   - `qa`: Hard deterministic layout validation (31 typed failure codes in `validate-layout-v2.ts`) and WCAG 2.2 p05 composite contrast check (`composite-contrast.ts`).
   - `transfer`: DSL v2 to PowerPoint/Canva bridge (`encodeEditableTransferV2`) preserving full layer editability, scrims, and script metadata.

2. **Durable Orchestration & Database Journal (Migration 013)**:
   - Orchestrated via `DesignStudioService` with PostgreSQL advisory locks per task (`pg_try_advisory_xact_lock`).
   - Resumable stage execution backed by append-only tables: `hawa.design_studio_runs`, `hawa.design_studio_candidates`, `hawa.design_studio_stages`, and `hawa.design_studio_calls`.
   - Hard budget cap enforcement (`BUDGET_EXHAUSTED`) bounding total run cost.
   - Worker crashes or restarts mid-stage resume cleanly from the last completed stage journal with zero duplicate billing.

3. **Operational Guardrails**:
   - Production deployment maintains `DESIGN_STUDIO_V2='off'` by default, preserving single-shot legacy path behavior until explicit operator enablement.
   - Explicit evaluation and testing route `POST /v1/tasks/:taskId/canva/studio` available for controlled qualification runs and Desk previewing.

