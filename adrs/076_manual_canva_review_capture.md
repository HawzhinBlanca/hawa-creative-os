# ADR-076 — Manual Canva capture becomes a server-recorded review

Date: 2026-09-27. Status: accepted for implementation; live admission remains open.

## Evidence and requirements

FR-001/041/043/064/069, NFR-017/020; docs/09, docs/10, docs/11, docs/14,
docs/17 and the current Canva contract. Desk's Capture for Review saved only a PNG.
The existing checked-export recorder refused NO_REVISION for manual requests, so
even a valid manually created design could not enter review through its button.

## Decision

Use the existing keyed Canva export operations and PostgreSQL revision/QC records.
Capture the PNG and then the checked PPTX with stable keys for one operator action.
Retain the action identity after uncertain responses and reloads. On a checked
manual export, lock the task and current binding and create its first revision
only from retained, hash-verified PNG/PPTX for the same observed Canva version.
Use the submitted exact copy; queue titles are not copy. Record the human capture
actor and actual retained source reference. Missing evidence leaves a visible
block, never a fabricated manifest, native layer tree or successful QA result.

Automatic revisions use the current revision/QC path. Manual recaptures record a
fresh source/preview map and invalidate prior approval; stale capture replay cannot
roll the revision back. RequestLifecycle-owned tasks
keep their owner and write guard. No generator is re-enabled, and no approval is
created by capture. Copy/font checks cannot substitute for native visual review.
Preview messages refer to the captured artifact and matched check; a task's status
alone is insufficient to label an arbitrary preview as passed.

The PPTX inspector supplies a text-only semantic map from the retained bytes,
with each object's actual slide part and unique shape ID. Missing or duplicate
identities block the first review. Source text is preserved separately from the
submitted copy, so a mismatch can be reviewed without rewriting facts. This map
proves addressable text in that PPTX only: native Canva verification stays unknown,
and logos, other assets, layout, portability and native reopening remain unqualified.
The existing approval gate is preserved; no placeholder nodes are created to pass it.

Migration 045 replaces Canva's unique `(design_document_id, source_sha256)` rule
with a lookup index. A source hash identifies bytes, not a review checkpoint:
identical PPTX bytes can accompany a new PNG, provider version or human decision.
Keep the real file hash, unique revision sequence, task lock and keyed capture
replay instead of changing bytes or inventing a different hash. Other studio
contracts retain their historical source uniqueness. The database test must prove
that a second capture invalidates approval once and replay does not add revisions.

## Acceptance

Prove first manual review, exact-copy failure, absent/mismatched/corrupt sources,
duplicate capture and concurrent replay, binding changes, closed-task and tenant
refusals. Exercise capture → review → approval → simulated delivery through the
deployed candidate. Native Canva edit/reopen and human quality remain separate.
