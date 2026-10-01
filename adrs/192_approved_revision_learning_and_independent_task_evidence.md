# ADR192 — Approved revision learning and independent task evidence

Date: 2026-10-01. Status: accepted for implementation; qualification pending.
Requirements: FR-022, FR-052, FR-053, FR-054, NFR-006, NFR-012.
Sources: docs/18_FEEDBACK_LEARNING.md, docs/08_MEMORY_RAG_CLIENT_DNA.md,
docs/14_SECURITY_THREAT_MODEL.md, MASTER_SPEC.md, ADR012/191;
W6_LEGACY_LEARNING_BOUNDARY_FINDING.json.

The legacy edit miner trusts supplied artboard/task identity and counts every layer
and replay as another observation. It invents a40px safe-zone rule from arbitrary
vertical moves. Human promotion stores prose in DNA without durable rule lineage.

Make the HTTP edit-mining path consume stored before/after revision IDs. Authorize
the task under RLS, require its current approved final revision and latest matching
server decision, derive bounded snapshots from actual recorded manifest properties,
and persist an immutable feedback event under an explicit UUID action key. Never
invent absent geometry, color or typography. Refuse malformed/unsupported manifests
with a visible diagnostic; text-only captures support only observed text differences.
Mine after commit and reconcile exact retries from the saved feedback event.

Count distinct tasks, not layers, repeated revision pairs or delivery retries.
Preserve exact content in pattern keys, observed changes and each revision/event
receipt. Present inferred adjustments for review without fabricating platform,
script or minimum-spacing explanations. Unverified direct library proposals must
not supply positive examples. Promotion writes the Client DNA version, immutable
rule representation and source evidence in an append-only audit event in the same
existing PostgreSQL transaction. No second active-rule registry is introduced.
Explicit owner instructions retain their human-governed proposal path: they do not
need to impersonate an observed approved edit.

Migration074 grants scoped read access to taskless client-rule promotion audits;
the prior task-based policy hid them, preventing authoritative retry detection.
A restrictive insert policy binds these audits to the current authorized writer.
Concurrent promotions reload active DNA under the existing client lock so one
promotion cannot erase another. The existing append-only guard remains in force.
No new orchestration framework or provider call is required. Stored
approval establishes office authorization of recorded source, not native visual
fidelity or human taste superiority. Process-local candidate queue rebuilding and
revision-level positive/negative learning, real native/human calibration and the
whole-product admission remain distinct obligations.

Acceptance: replay/multi-layer edits count one task; an independent task increments
once; mismatched scope, malformed geometry/IDs, copy-prefix collision and changed
event reuse refuse or stay distinct. Actual HTTP/isolated PostgreSQL cases require
stored revisions/approval, refuse supplied artboards/missing/stale/cross-task/client
evidence, retain actor/approval/hash lineage and reconcile retries. Human promotion
persists linked source evidence atomically; injected failure rolls back DNA/rules.

Connected qualification:7files/69pass/0fail,662 strict roots and lint pass.
Retained initial7 domain failures and connected/type failures establish controls
and fixture/build repairs; detailed history in W6_APPROVED_REFINEMENT_PROOF.json.
Exact sealed full gate pending; source-only, no paid/native/human admission.
