> **WITHDRAWN 2026-09-17 — DO NOT IMPLEMENT.** This sheet had the stage order wrong: it generated a
> flat image first and rebuilt it as layers afterwards. The state of the art (CreatiPoster, arXiv
> 2506.10890) generates the editable layout first and paints the art afterwards, conditioned on it.
> Replaced by `output/plans/2026-09-17-research-grade-pipeline/GEMINI_TASK_SHEET.md` (P01–P10).
> Reasoning: `output/research/2026-09-17-pipeline-research/RESEARCH_BRIEF.md`.

# Concept-First Design Flow — task sheet for the implementing agent (2026-09-16)

**Branch:** `studio-v2`. **Rules:** every rule in `output/plans/2026-09-16-flawless-system/GEMINI_PROMPT.md`
applies unchanged (clean tree at deploy, no direct table writes, live ids in proofs, BLOCKED over
substitution, no quality adjectives as results). **Status:** Proposed; the lead accepts each task only
after re-execution. **Priority:** after round-3 items R1–R4 are accepted; R1 (billing probe) first.

## 0. Goal, in one paragraph

A requester on Telegram sees three flat concept boards within a minute of sending a brief, picks one
with one tap, and then receives an editable Canva draft built to match that board with exact copy,
brand fonts and the logo. Approval happens on the editable draft, never on a flat image. Flat boards
come from `gpt-image-2.5-sunburst`; `gpt-6-astra` writes the board prompts, judges the boards, and
scores how closely the editable draft matches the picked board. Nothing else in the system changes.

## 1. Flow

```
brief (Telegram) ─► classify (F07) ─► C1 concept prompts (Astra, 1 call)
  ─► C2 three boards (Sunburst, low/medium quality, text-free or English headline only)
  ─► C3 board judge (Astra, 1 call, all three boards, low detail) ─► drop boards that fail
  ─► C4 send boards to requester with pick buttons ─► requester taps one (or "none, redo")
  ─► C5 editable build: existing planner / Studio v2 with picked board as reference image
  ─► C6 parity: Astra compares Canva export with the picked board ─► status note
  ─► existing QA, Canva import, export checks, approval on the editable draft
```

Hard limits: 3 boards per brief, 1 redo round, ≤ USD 1.50 per brief for C1–C3, ≤ USD 40 per day for
boards across the office. Beyond a limit the flow skips boards and goes straight to C5, saying so.

## 2. Tasks

### C01 — Storage and flags
**Do:** migration `014_concept_boards.sql`: table `hawa.concept_boards` (id, tenant_id, task_id,
round, ordinal 1–3, prompt, model, request_id, image_sha256, image bytes or storage key, quality,
cost_usd, judge_score, judge_notes, status `generated|rejected_by_judge|sent|picked|declined`,
created_at) with RLS like `design_studio_candidates`. Flag `CONCEPT_FIRST=off|on`; per-sender opt-out
in intake (`studioOptions.concepts: 'none'`).
**Accept when:** migration applies and reverts in the test stack; RLS policy proven with the tenant-mismatch
test used for migration 013; flag off leaves every existing path byte-identical (zero-change Telegram
request replay, as in D8 of the original sheet).
**Proof:** `C01_MIGRATION.md`: apply/revert log, RLS test transcript, zero-change replay journal.

### C02 — Concept prompt writer (Astra, one call)
**Do:** one `gpt-6-astra` call with a cached system prefix (brand rules, typography policy, exemplar
images as `image_url` detail `low`, the P0 safety prefix) and the brief; `response_format` json_schema;
`max_completion_tokens: 900`. Output: three prompts, each with archetype family, palette usage, calm
region for copy, mood, and the single English headline allowed in the image if any. Rules inside the
prompt: no Sorani text in images ever, no seals, flags, emblems, faces, no invented names or dates, no
copy beyond the one headline.
**Accept when:** ten held-out briefs (five Sorani) yield thirty prompts, none containing Sorani text,
names, dates or emblem words; the cached prefix shows `cached_tokens > 0` from the second call on.
**Proof:** `C02_PROMPTS.json`: thirty prompts, call ids, token usage per call, cached tokens.

### C03 — Board generation (Sunburst)
**Do:** `OpenAiImageProvider` gets `quality: 'low' | 'medium'` and `size` from the brief's aspect ratio;
boards default to `medium`, previews for Telegram downscaled to ≤ 1280 px and ≤ 300 KB. Store
`x-request-id`, `usage.output_tokens_details.image_tokens`, and cost from the token price (F11). Three
boards are requested concurrently; one failure does not block the others.
**Accept when:** three boards for a real brief are stored with real request ids and costs that the lead
recomputes from image tokens; the Telegram preview is under the size limit; a forced provider error on
one board still delivers two.
**Proof:** `C03_BOARDS/`: three PNGs, `receipts.json`, ledger rows.

### C04 — Board judge (Astra, one call, all boards)
**Do:** one call with the three boards at `detail: low`, the brief, and the brand rules; json_schema
output per board: `{legibleCalmRegion, brandPalette, forbiddenContent, textPresent, textCorrect,
score, reason}`. Any board with forbidden content or wrong text is `rejected_by_judge` and never
sent. Same facts-first, order-swap-free single call; `max_completion_tokens: 600`.
**Accept when:** a canary board with a drawn emblem and one with a misspelled headline are both
rejected in a live run; three clean boards pass; the call costs under USD 0.10.
**Proof:** `C04_JUDGE.json`: canary and clean results with call ids and costs.

### C05 — Telegram delivery and pick
**Do:** send the surviving boards as one media group with a caption "Concept previews, not final copy.
Pick one." and inline buttons `Concept 1 / 2 / 3 / None, redo` carrying signed tokens from
`TelegramActionTokenService.createToken` (new action `pick_concept`, one-time, expiring in 24 h).
The webhook handles `pick_concept` before the existing "Desk review required" refusal for approve/
publish. A pick records `status: picked` and starts C06; `None, redo` allowed once, then the flow
continues without boards. Timeout 24 h → continue without boards and say so. All texts in the
requester's language (English or Sorani).
**Accept when:** the lead picks a board from a test chat and sees the pick in `concept_boards` within
5 s; a replayed token is refused; the redo path runs once and the second redo is refused with a
message; the 24 h timeout is tested with a shortened interval in the test stack.
**Proof:** `C05_PICK.md`: journal excerpts, token verification log, the two messages as received.

### C06 — Editable build guided by the picked board
**Do:** pass the picked board to the existing planner and Studio v2 as `referenceImageBase64` with
the instruction "match this concept's composition, palette usage and hierarchy; copy, fonts and logo
are governed by the brand rules, not by the image". Studio v2 seeds its concepts from the board
(one concept must be the board's archetype). No coordinates are copied from the image.
**Accept when:** for two real briefs the editable draft visibly follows the picked board (lead judges
by eye) and passes copy, font and logo checks; the plan JSON contains no pixel coordinates copied
from the image.
**Proof:** `C06_BUILD/`: picked board, editable export, plan JSON, check JSON, for two briefs.

### C07 — Parity note
**Do:** one Astra call comparing the Canva export with the picked board: `{parity: 'close'|'partial'|
'different', divergences[]}`; the requester's ready message states it ("Built from Concept 2; layout
close to the preview" or "differs: …"). Never claim a match the judge did not give.
**Accept when:** two live drafts carry truthful parity notes matching the lead's own view of both images.
**Proof:** `C07_PARITY.json` with call ids and the two messages.

### C08 — Budget, caps, degradation
**Do:** per-brief and daily caps from section 1 in the cost governor; when a cap is hit, boards are
skipped and the requester message says the draft was built without previews; ledger rows for every
board and judge call; a `/concepts off|on` operator command.
**Accept when:** the lead lowers the daily cap to USD 0.01 in the test stack and a new brief goes
straight to the editable build with the truthful message; the ledger sums to the OpenAI dashboard for
the test window.
**Proof:** `C08_BUDGET.md`: cap test journal, ledger sum, dashboard screenshot from the owner.

## 3. Token and cost discipline (applies to every task)

- One Astra call per stage, never one per board. Boards go to the judge together at `detail: low`.
- Cached system prefix for C02 and C04; prove `cached_tokens` in receipts.
- `max_completion_tokens` on every call; json_schema on every call; no free-text reasoning returned.
- Sunburst `medium` for boards, `low` for redo; never `high` in this flow.
- Expected cost per brief: about USD 0.25 for three boards, USD 0.15 for the two Astra calls, under
  USD 1.50 hard cap. Expected time: under 60 s to boards, under 3 min to the editable draft.
- Proof bundles: JSON and PNG only, no prose beyond what the sheet asks; no screenshots of terminals.

## 4. Proof bundle and reporting

Folder `output/proofs/2026-09-16-concept-first/` with `PROOFS.json` (sha256, command, commit per
file), `LEDGER.csv` (every paid call), `DEVIATIONS.md`. Reporting format as in the flawless sheet
(`TASK / STATUS / COMMITS / PROOF / LIVE IDS / DEVIATIONS / WHAT I DID NOT DO`). Ship behind
`CONCEPT_FIRST=off`; the lead turns it on for one test chat first, then for the office.

## 5. What is not in scope

Flat boards as deliverables; Sorani text inside images; approval on a flat image; converting an
image into layers; any change to the Canva import, export or QA path; the Canva MCP lane (F13).
