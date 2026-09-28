# ADR-125 — One negative-space policy and an executable brief contract

Date: 2026-09-28. Status: implementation; locally qualified, human and native evaluation open.
Requirements: FR-013/014/015/036/038, NFR-024. Normative sources: docs/05_CREATIVE_ENGINE.md,
docs/08_MEMORY_RAG_CLIENT_DNA.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md,
docs/11_QA_RTL_MULTILINGUAL.md, docs/30_CURRENT_STUDIO_CONTRACT.md.

## Context

The final review found that the v3 layout prompt asked for negative space of "0.35 to 0.58 of
canvas area" and said "never leave 40% of the canvas empty", while the checker the candidates are
ranked, repaired and judged by passes measured-line emptiness from 0.36 to 0.84 and penalises gaps
from 0.22 of canvas height. The design-precision probe measured a design at 0.80 that passes the
checker and violates the prompt. The generator therefore optimised against a different policy.

The Studio brief is a model's reading of the request. Its fields travel to the layout call as one
JSON object with no statement of which facts are authoritative. The model's readingOrder is a
proposal (ADR-109/116), but nothing recorded which facts were client authority, which were house
checks and which were model guesses, and a request whose copy no layout can set still reached the
paid layout call.

## Decision

**One versioned negative-space policy.** `studio.negative-space` version `2026-09-28.1` holds the
occupancy rules, both measure bands, the gap and bottom-void penalties and the pass score. The
checker scores through it and records its id, version, digest and measure with every result. The
generator's statement is rendered from the same record, including what the measure does not count
(photographs and artwork). The numbers are the checker's existing calibration, so no accept or
reject decision changes; a change of any number needs a new version, a new recorded digest and
qualification of the decisions it moves. Whether that calibration reflects the owner's exemplars
remains the open question already recorded on the metric.

**An executable brief contract.** Before the first layout call, a new or afresh-designed Studio run
builds one contract from its own authorities and records it on the run's stages, with the policy
identities it was built under. Each fact appears once, in one layer, with one authority:

- exact content: each copy block by hash (source copy, or run-effective copy after a directed
  edit), the client logo and each content photo by hash. The copy text itself stays in the request.
- communication intent: the client's instructions by hash, and the model's summary, hierarchy and
  reading order as proposals. The reading-order proposal records whether it matches source order.
- protected design: source-copy reading order and the relations existing checks enforce, in the
  layout relationship vocabulary (`readingOrder`, `keepInside`, `noOverlap`, `aspect`), naming the
  enforcing defect codes; standing client rules by hash, stated as unverified by any check.
- permitted change: composition freedoms and cover-fit photo `crop`.
- soft preference: model `must`/`mustNot`, imagery, style values (logo corner as `anchor`),
  background request and reference notes. Preparation may apply some as defaults; none is a check.
- unknown: model risk flags, images classified unrelated, an unseen reference, unmeasurable fit.

Element IDs are the renderer's (`text-copy-N`, `logo`, `photo-N`), independent of model role
labels. Validation refuses a model proposal in the exact, protected or permitted layers, duplicate
facts, unknown elements or relations, and choices outside the authorized list. The digest uses
canonical JSON so it survives JSONB storage. On resume the recorded contract must be intact and
equal to the rebuilt one, otherwise the run holds (`BRIEF_CONTRACT_CHANGED`) before the provider.

Disagreements are recorded with their resolution instead of being resolved silently: a reading
order proposal that is not adopted, a no-imagery brief with client photos (photos kept), and a
background request mapped to a palette colour. The one blocking conflict implemented is copy no
layout can set: a free screen measures each block at the 12px minimum in every face the validator
admits for its script (regular and italic for Latin, at the tightest admitted tracking) inside the
safe width, with QA's own measurement and width tolerance. If every admitted face was measured and
all exceed it, the run stops (`BRIEF_CONTRACT_CONFLICT`) before layout with a short explanation and
only `CLIENT_APPROVES_REVISED_COPY` or `CHOOSE_WIDER_APPROVED_FORMAT`. An unmeasurable face makes
the result unknown, never a conflict. Copy is never shrunk, omitted, split or reworded.

The layout call receives a compact rendering of the contract before the unchanged structured brief
JSON, which is now labelled as proposals. No migration, provider call or dependency is added.

## Acceptance

Policy: pinned digest per version; passing interval derived from the scoring function and checked
against a sweep; generator prompt contains the rendered statement and none of the contradictory
numbers; probe values reproduced. Contract: exact hashes, proposal/protection separation, forged
promotion refused, vocabulary and stable IDs, surfaced disagreements, blocking conflict wording
and choices, legacy partial briefs, canonical digest. Screen: validator face set, true positive,
break opportunity and wide format negatives, Sorani, unmeasurable fonts. Core: real isolated
PostgreSQL, runtime-role connection, contract recorded before the layout boundary, blocking stop
with no layout or transport call, intact reuse and changed-contract hold.

## Local qualification — 2026-09-28

Four new files: 21 tests pass. The initial run failed all four (three modules missing; in the Core
file the unbroken copy reached the layout boundary and no contract was recorded). Affected package
files: 32 files, 377 passed. Affected Core/worker files: 26 files, 241 passed, 2 failed; both
failures are in `studio-ledger.test.ts`, reproduce on the base service source, and stop at
`db.transaction is not a function` before the laying-out stage. The full suite ran once: 536
files, 4,468 passed, 9 failed, 60 skipped; all 9 failures reproduce with the base sources restored
(stale migration and route lists, an unbuilt Desk bundle, the release manifest and the two ledger
cases). Build, source/scripts types, 537 strict test roots, any ratchet, egress and security pass. See
`plans/lean-design-implementation-2026-09-28/BRIEF_CONTRACT_PROOF.json`.

The screen detects only unbreakable runs; aggregate area capacity, hierarchy feasibility and
client-rule enforcement are not screened. Negative space still ignores photographs and artwork,
and the v2 Desk `whitespaceRatio` remains a separate unweighted box-coverage display figure. The
generator's margin statement (0.05 normalized) is looser than the validator's 6% of the short
edge; this is the same class of drift and is not corrected here. Directed edits do not yet carry
an edit contract. No paid, native, human-quality or release evidence is claimed; whether the
unified statement or the contract improves accepted designs needs the equal-budget comparison.
