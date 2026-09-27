# Lean design implementation

User authorization: implement all recommendations in the 2026-09-28 lean architecture report.
Starting source: `67cbc2e9`, existing branch `codex/research-grade-design-system`.
Research: `output/research/2026-09-28-lean-design-architecture/REPORT.md` and its retained evidence.

## Scope and completion ledger

The entire six-package objective remains active. Source implementation, local qualification,
native capability admission, human quality evaluation and production admission are separate evidence.
No package is complete merely because a smaller test passes.

| Package | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Preserve uncertain Canva effects, current native revision basis and unrelated manual edits | In progress: uncertainty slice locally qualified; native revision preservation open | ADR-108; CANVA_UNCERTAINTY_PROOF.json |
| 2 | Complete brief handoff, full copy geometry, scoped visual references/photo meaning, faithful refinement assets | In progress: input/asset handoffs locally qualified; authorized visual-order contract, multilingual retrieval and human comparison open | ADR-109; CREATIVE_HANDOFF_PROOF.json |
| 3 | Free feasibility before art, eligible-only judging, retained typed responses, pinned derivations, safe bounded concurrency | Open | No new implementation evidence |
| 4 | Amend/Adapt routing and actual Canva account capability qualification | Open | Official documentation is not account admission |
| 5 | Relationship-led composition, calibrated selection, governed edit learning and equal-budget human comparisons | Open | Existing R04–R06/R13/R22–R25 study machinery must be reused |
| 6 | Complete supervised native review/delivery, release qualification and independent recovery | Open | Prior qualification remains scoped to its own candidate |

## First slice: creation uncertainty

Requirements: FR-060, NFR-001, NFR-020, NFR-024; R07/R21.
Normative sources: `MASTER_SPEC.md`, `docs/10_WORKFLOW_RELIABILITY.md`,
`docs/30_CURRENT_STUDIO_CONTRACT.md`, linked through `plans/traceability.csv`.

Acceptance: no second design after lost creation reply, age/sweep, missing job read,
authorization failure or a legacy failed record without positive failure evidence.
Definite provider refusal/failure stays retryable under a new key; an explicit resume
can recover the original job without another creation. Polling is bounded and the
operator sees what requires reconciliation. Concurrent success must not be demoted.

## Verification policy

Use directly affected fake-provider/PostgreSQL tests first, preserve failures, then
source/test type and architecture checks. Perform full candidate qualification once
the integrated release is ready. Paid/native calls need the already required scoped
budget and actual application capabilities; human approvals cannot be substituted.

## 2026-09-28 — First implementation checkpoint

ADR-108 is implemented and locally qualified: uncertain outcomes and historical
failed records without positive evidence cannot permit another design creation.
An explicit original-job check recovers work; polling stops after a durable hold;
Desk explains reconciliation. Pure policy rejects mismatched job evidence and
contradictory returned design identity. Late sweep/read results preserve concurrent
completion. Existing export recovery semantics remain separate.

Six new cases failed before the source correction. Final affected acceptance:
23 files, 296 passed, zero failed/skipped; 514 strict test roots and Desk build pass.
Initial sandbox PostgreSQL/tsx-IPC failures and superseded expectations are retained
in the proof. Source/scripts types, any-count and provider-egress checks passed.
No full release qualification, production deployment, paid calls, native manual
recovery or human-quality study occurred. See `CANVA_UNCERTAINTY_PROOF.json`.

Next: qualify current native revision admission and preservation, then complete
brief/visual handoffs and remove unnecessary creative work. The full six-package
objective remains active; this checkpoint is not a completion claim.

## 2026-09-28 — Creative handoff checkpoint

ADR-109 preserves the full structured brief and complete exact copy in the existing
layout call. Importance and subject/crop notes survive. At most two approved scoped
examples and every classified content photo arrive as pixels, capped at 768px per
edge, with original hashes. Retrieval uses the actual request and saved copy;
the layout stage no longer performs an independent global lookup. Explicit client
references remain last. Source-copy order remains protected: the model brief's
readingOrder is a proposal, not authorization to override client copy ordering.

Rendering, refinement, fallback comparison and both sides of a comparison canary
share the candidate's real logo/art/photos/cutouts. Saved artwork is reloaded for
critique/revision/judging. Refinement also receives the explicit client reference.
No-imagery briefs suppress optional art, including after refinement preparation;
required client photos are retained.

Qualification: 13 affected files passed, 162 tests passed, zero failed, one optional
12 MP external-photo test skipped because HUNT_PHOTO is unset. All 515 strict test
roots, source/scripts types, any-ratchet, provider egress and security scan pass.
The first red run contains four reproduced input losses and one invalid test
fixture setup; the fixture was corrected. A local pixel comparison proves canary
asset fidelity. No extra model calls were added; image conditioning adds input
cost, which has not been measured with a paid provider.

Open: multilingual retrieval experiment; explicit authorized visual order;
durable asset derivation pinning; equal-budget human quality comparison; native
revision preservation; the remaining packages. This is local source qualification,
not a deployment or completion of the six-package goal. Next independent work:
free feasibility before optional artwork and eligible-only comparative judging.
