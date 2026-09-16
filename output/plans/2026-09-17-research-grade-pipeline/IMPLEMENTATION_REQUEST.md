# Implementation request — research-grade design pipeline (2026-09-17)

To the implementing agent. Implement the pipeline specified in
`output/plans/2026-09-17-research-grade-pipeline/GEMINI_TASK_SHEET.md`, tasks **P01–P10**, in full, with
the proof required by each task. The reasoning and the citations behind every design choice are in
`output/research/2026-09-17-pipeline-research/RESEARCH_BRIEF.md`; read it before starting, because
several tasks will look arbitrary without it and you should not "improve" them back into the shape the
research rejected.

## What changed and why you must not implement the previous sheet

`output/plans/2026-09-16-concept-first/GEMINI_TASK_SHEET.md` (C01–C08) is **withdrawn**. It generated a
flat concept image first and rebuilt it as layers afterwards. The state of the art does the opposite:
CreatiPoster (arXiv 2506.10890) emits the editable layer specification first and paints the background
afterwards, conditioned on the rendered foreground; PosterLLaVa and DesignAsCode agree. Raster-to-layer
decomposition was checked and rejected on evidence: LaDe (2603.17965) can decompose an image into RGBA
layers but renders text as pixels rather than native editable type, which cannot serve character-exact
copy in Canva. Do not reintroduce a flat-first stage in any form.

## Order of work

1. **Round-3 items R1–R4 first**, from `output/plans/2026-09-16-flawless-system/GEMINI_PROMPT_ROUND3.md`.
   R1, the proactive billing probe, is the most urgent item in the repository: production health reported
   the model provider connected while a real call returned credit exhaustion. OpenAI credit has since
   been added by the owner, which removes the blocker on F02, F05 and the live runs, but it does not fix
   the blindness.
2. Then **P01 before anything else in this sheet**. It is the free deterministic gate that every later
   stage depends on, and it is the largest single quality and cost lever available.
3. Then P02 → P03 → P04 → P05 → P06 → P07 → P08 → P09, then P10 qualification.

Ship behind `DESIGN_PIPELINE_V3=off`. Write **ADR-031 in `Proposed` status**; do not mark ADR-029
superseded, this refines it.

## Rules

Every rule in `output/plans/2026-09-16-flawless-system/GEMINI_PROMPT.md` applies unchanged. The ones
that have actually been violated in previous rounds, restated:

- **Nothing reaches production from an uncommitted tree.** `HAWA_BUILD_COMMIT` must equal
  `git rev-parse HEAD` with a clean tree at deploy time.
- **Never present an old artifact as fresh proof.** In round 2 one of three "independent" layout plans
  was a task created before the round and before the typography policy existed. Generate new task ids
  for new proofs.
- **Never write a claim next to evidence that contradicts it.** In round 2 a proof summary stated
  "verified font and copy pass" for three exports whose adjacent check files all said `fontPass: false`.
  Every sentence in a proof document must match the JSON beside it.
- **Report removed or weakened assertions truthfully.** Round 2's `CHANGES.md` claimed zero removed
  assertions while the diff removed forty-one and deleted a snapshot.
- **Report blockers as blockers.** Round 2 did this correctly for three tasks, with the exact provider
  error and what was needed. That was right. Keep doing exactly that.
- **No quality adjectives as results.** Not "flawless", not "10/10", not "production-grade". Numbers and
  artifacts only.

## Token discipline, which is part of the specification

- One model call per stage. Never one call per candidate where one call can cover all three.
- A single **byte-stable cached prefix of at least 1,024 tokens** holding the safety prefix, brand rules,
  typography policy, metric definitions and rubric. No ids, no timestamps, no per-request text inside it;
  dynamic content goes last. Cached reads cost a tenth of the input rate, and a single varying character
  destroys the cache.
- All critique and judging images at `detail: "low"`, a flat 85 tokens each.
- The cascade is free → cheap → expensive: deterministic metrics, then one critique call, then the judge
  only on survivors. Skip the judge entirely when one candidate survives.
- Strict-mode schemas, `max_completion_tokens` on every call, no `$defs`.
- Caps: USD 1.00 per brief for P03–P07, USD 30 per day office-wide. Over a cap, finish with the best
  passing candidate and say so in the requester's message.
- Target: under USD 0.25 for a simple brief with no art and one surviving candidate. The published
  comparison point for a similar system is USD 0.38 per request.

## Proof bundle

Folder `output/proofs/2026-09-17-research-grade-pipeline/` containing exactly the files each task names:
`P01_METRICS.md`, `P02_RETRIEVAL.json`, `P03_LAYOUTS/`, `P04_ART/`, `P05_CRITIQUE/`, `P06_REFINE.json`,
`P07_JUDGE.json`, `P08_PICK.md`, `P09_COST.md`, `P10_QUALIFICATION.csv`, plus `PROOFS.json` (sha256,
producing command and commit per artifact), `LEDGER.csv` (every paid call with provider request id,
tokens, cached tokens and recomputed cost) and `DEVIATIONS.md`.

Every live claim needs a provider request id that resolves to a row in the database. Every image must be
a real capture produced by the command stated. Offline or fixture results belong in files named
`*.offline.*` and are never quoted as live gates.

## Limits to declare in DEVIATIONS.md rather than paper over

- The metric thresholds are calibrated against twelve exemplars **the owner has not yet confirmed**. Ship
  the code and state that retrieval and calibration quality are unverified until confirmation.
- The self-preference mitigation in P07 reduces judge bias by roughly a third and does not remove it. A
  second-family judge stays preferable and is currently unavailable.
- Computational aesthetic metrics correlate with human judgement at about ρ = 0.68, ρ = 0.74 on
  structured compositions. They gate; they do not decide.
- The Canva MCP lane (F13) remains blocked on the owner's OAuth grant. Do not attempt it.

## Reporting

One block per task, this exact shape, nothing else:

```
TASK: P0x — <name>
STATUS: DONE | PARTIAL | BLOCKED
COMMITS: <sha list>
PROOF: <file paths>
LIVE IDS: <provider ids or "none">
DEVIATIONS: <exact text or "none">
WHAT I DID NOT DO: <exact text or "nothing">
```

No summary tables of PASS columns. No descriptions of images; the lead opens them. No requester chat ids
or tokens anywhere in a proof or a commit message.

The lead re-executes every proof before any task is marked accepted.
