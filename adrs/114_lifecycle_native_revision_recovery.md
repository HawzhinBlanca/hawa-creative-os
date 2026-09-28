# ADR-114 — Request-owned native revision recovery

Date: 2026-09-28. Status: accepted; local linked-revision recovery qualified, live/native qualification pending.

## Context

FR-029/041/042/060, NFR-009/024; docs/05, docs/10, docs/11 and docs/30,
linked through plans/traceability.csv. ADR-113 safely holds linked revisions
but its manual handoff excludes RequestLifecycle tasks. The owner must be able
to adopt checked native work without a legacy endpoint advancing its state.

## Decision

During the current request's manual stage, an office human can link a separate
native revision copy, confirm exact text/preservation, and capture exports.
These narrowly admitted preparation operations carry explicit request ID/revision
and recheck it under the lifecycle lock in their write transaction. No generation,
new native creation, task replacement or approval is authorized by that delegation.

Submission for review is a signed office event through the existing gateway to
RequestLifecycle. Core atomically checks the current request/task, confirmation,
binding and retained exports, records the revision and QA, advances manual to
in_review, and commits a hash-bound projection receipt. The owner adopts that
receipt, including after a response/state-save failure. Capture retrieval alone
cannot advance the owned request. Identical old submissions return their original
receipt without modifying a newer request; conflicting keys are refused.

This completes the linked-revision recovery route for automatic lifecycle requests.
Initial manual requests without a design run need their own admitted source-copy
journey; do not fabricate a run or silently grant that separate capability.

## Options and trade-offs

- Unrestricted legacy writes would create two state owners and are rejected.
- Routing every read-only export poll through the owner would serialize slow
  provider reads unnecessarily. Narrow preparation with transaction checks keeps
  the current export implementation and its reconciliation receipts.
- Only the review transition goes through the durable owner. This requires a
  signed event and projection, but preserves one approval/delivery journey.

Native preservation remains human testimony with actual captured evidence;
local locks cannot fence direct Canva edits. Existing live qualification remains
required. A review submission is not approval, even when critical QA passes.

## Acceptance and actions

Prove current manual preparation, refusal in other/stale rounds, human-only scope,
no fresh generation, capture without owner transition, and signed submission
through owner/Core projection to review. Exercise exact replay, altered-key body,
lost projection reply, stale confirmation/binding/capture, cross-client data and
the existing explicit approval path. Retain real database and file checks with
synthetic provider transport; report native/human/release limits separately.

## Local qualification

The connected regression run passed 198 tests across 23 files. After adding an
active-user check, the restricted database role exposed the users FOR SHARE RLS
policy trap; a plain scoped SELECT fixes it without widening grants. The final
boundary run passes 63 tests across six files, including the restricted runtime
connection and disabled-user refusal. This is an active-user snapshot check;
it does not serialize concurrent user revocation. Request changes remain locked.

Exact evidence and retained failures: `plans/lean-design-implementation-2026-09-28/LIFECYCLE_NATIVE_RECOVERY_PROOF.json`.

Final connected-source verification after the fix: **24 files / 220 tests passed, zero failures or skips**.
