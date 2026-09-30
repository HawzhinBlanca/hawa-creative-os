# Judge: art direction for photo briefs

Part of ADR-170 (creative photo art direction). Code: `pairwise-judge-v3.ts`, `box-critique-v3.ts`.
Tests: `packages/creative/test/judge-art-direction.test.ts`.

## Why

On 2026-09-30 the owner rejected a KAAE draft with one photo centred in a framed rectangle; an
earlier draft was a 3x2 grid of equal tiles. The judge had helped pick both. None of its five
dimensions looked at the photos. "Negative space" and the fallback wording "restraint" read a
full-bleed hero as clutter. The deterministic metrics it must "take into account" count a photo as
occupied area and reward centred mass. Research on design judges (Vibe Design Agents 2026; PRISM)
finds they prefer the safe, typical design unless anchored against it.

## What changed

- **Photo brief** = either candidate places a photo (`isPhotoBrief`), or the caller sets
  `JudgeOptions.photoBrief`. It gets a sixth dimension, `art_direction`. That covers: a clear hero that
  fits the subject; bold, full-bleed or dominant use rather than a framed tile; text on a plate,
  card or fade; a concept connecting photo and title; photo grids are bad unless the subject is a
  gallery; and compliance with the client's house rules.
- **Weights (photo):** hierarchy 2, art_direction 2, legibility 2, composition 1,
  typographic_craft 1, brand_fit 1. The total is 9, so a design needs 5 to win and there are no
  ties. Legibility rises with art direction, so boldness cannot win by putting copy on a busy photo.
  Art direction and hierarchy together (4) are not a majority.
- **Wording (photo):** composition treats a full-bleed photo with a quiet region or a fade as
  breathing room. Restraint means palette and element count, not photo size. A note tells the model
  that the metrics miscount photos and should be read for the text blocks.
- **House rules:** `JudgeOptions.houseRules` takes short sentences, numbered R1… and quoted as data.
  The limits are 16 rules of 240 characters each. They weigh in art_direction and brand_fit (brand_fit
  alone on typographic briefs).
- **Baseline anchor:** `CandidateJudgeInput.baseline`. When exactly one candidate carries it, the
  user turn names it by letter in each order. The prompt says a bolder candidate wins when it is
  equally legible and on-brand. This is deterministic, needs no extra call, and leaves the cached
  system prompt unchanged.
- **Checklist:** photo replies carry a per-candidate checklist first (`artDirection`). It is
  recorded on the result as evidence and does not override votes.
- **Critique:** on photo layouts only, the critic is told not to ask for a photo to be shrunk,
  framed, inset or tiled to create whitespace. The prompt now states the detail it actually sends.

**Typographic briefs are unchanged:** the system prompt is byte-identical to 051d5606 (a sha256 in
the test locks it), with the same schema object and five equal votes.

## Contract

The additions are optional only. `JudgeDimension` and `JUDGE_DIMENSIONS` are unchanged;
`votes.art_direction` and `rationales.art_direction` appear on photo briefs.
`OrderComparisonResult` gains `photoBrief`, `weights`, `weightedVotesA/B`, `artDirection` and
`baselineCandidateId`. `winnerVotesA/B` still count dimensions won. On a photo brief the winner
follows the weighted votes.

## Cost

The pipeline still makes 4 calls on gpt-4.1-mini (2 order-swapped plus 2 canary), with
`maxTokens` 2000. The judge already sends images at `high` detail on gpt-4.1-mini. The reservation
prices every patch-model image at its full patch count whatever the detail: 1080x1080 is 1,875
tokens and 1080x1350 is 2,371 tokens. So high detail costs nothing beyond what is already reserved.
Measured reservation per call, with two 1080x1080 renders:

- typographic: $0.007581 (10,952 input tokens), unchanged;
- photo brief with 10 house rules and a baseline: $0.010454 (18,135 input tokens).

That is about +$0.0115 reserved per design across the four calls. The billed increase is roughly
1.3k input and 150 output tokens per call, about $0.003 per design.

The critique stays at `low`. Production critique runs on gpt-6.1-sol, where images are counted
natively and high detail would bill more.

## Not done here

- The pipeline does not yet pass `houseRules` or mark a baseline candidate. The pipeline owner
  must wire both.
- Core persists `votes` and `rationales`, so `art_direction` is stored; the weighted fields are not
  yet stored.
