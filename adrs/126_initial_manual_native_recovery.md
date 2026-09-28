# ADR-126 — Owner-controlled native recovery for initial manual requests

Date: 2026-09-28. Status: accepted; local qualification only, live/native qualification pending.
Requirements: FR-029/041/042/060, NFR-001/009/020/024. Normative sources:
docs/05_CREATIVE_ENGINE.md, docs/10_WORKFLOW_RELIABILITY.md,
docs/11_QA_RTL_MULTILINGUAL.md, docs/30_CURRENT_STUDIO_CONTRACT.md.

## Context

ADR-114 admits native preparation and a signed review submission only for the
current manual stage of an automatic linked revision. A RequestLifecycle request
opened for manual design (autoGenerate false, or a declined automatic open) has
no design run and no parent design. Its owner state has no run identity, so every
review, approval and delivery handler refused it, and Core refused its design
writes. The office could not bring such a request to review at all.

## Decision

Identify the origin from the immutable first projection receipt: key
`<request>:1:open`, stage manual, autoGenerate false, the same root/current task,
and no Studio run state on that task. A mutable request stage is not the authority.
Do not fabricate a run or design input.

At request revision 1 in the manual stage, the office human may link the request's
own separate design, confirm exact final text and capture PNG/PPTX, with the same
explicit request headers, lifecycle lock, active-user snapshot check and human-only
scope as ADR-114. There is no parent to preserve; the human asserts that the linked
design is this request's own separate design. The existing global design-binding
uniqueness refuses a design already linked to another task. An owned capture needs
a current confirmation. The confirmation is an immutable task event with its own
schema (`initialNativeCopy`) and export policy kind (`initial_client_dna`).

Migration 069 extends the policy-currency function: an initial policy is current
only for the latest human confirmation, its exact copy, the same binding version and
design, the confirming request's ownership, and the active human-authored Client
DNA. Once a task has an initial confirmation, other and policy-less captures cannot
qualify it. Review, approval pinning and publication checks use this function.

Submission reuses the ADR-114 signed event at `expectedRev` 1. Core projects one
revision, QA run and manual-to-in_review change with a hash-bound receipt.
RequestLifecycle adopts it into a separate manual-origin state without a run. That
state accepts approval, rejection and delivery. It refuses a requester revision
round, both in the owner and in Core's office-decision projection, because the
manual stage at a later revision routes the requester's reply into automatic
generation. The office rejects instead, or a later decision can add a manual
office-revision route.

## Options and trade-offs

- A synthetic run identity would make the existing handlers accept the request, but
  it would claim design work that did not happen and could start generation.
- Reusing the revision confirmation with empty parent fields would fail or weaken
  the revision policy checks. A separate schema keeps both contracts exact.
- Refusing requester revisions narrows the office's choices for these requests.
  Admitting them safely needs a manual-origin intake route; that is a separate change.

## Acceptance

Real isolated PostgreSQL, restricted `hawa_app` connections and synthetic Canva
transport: rev-1 preparation, capture without advancement, signed submission with
lost Core and gateway replies, fresh-connection receipt replay, conflicting replay,
approval without rewind, stale confirmation/binding/task/capture and disabled actor,
automatic, fallen-back, stale-header, later-stage and run-bearing requests fenced,
design already linked elsewhere refused, policy invalidation, refused revision
round, owner delivery transitions and Desk retention across remount.

## Local qualification — 2026-09-28

See `plans/lean-design-implementation-2026-09-28/INITIAL_MANUAL_RECOVERY_PROOF.json`
for exact counts, source hashes, retained failures and limits. The non-lifecycle
manual path (ADR-077) keeps Core as owner, the saved request copy as authority and
review on capture; it needed no change. No live native call, paid call, production
migration, deployment, human preservation judgment or process-kill drill occurred.
