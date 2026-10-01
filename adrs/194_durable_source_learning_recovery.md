# ADR194 — Recover governed learning from durable sources

Date: 2026-10-01. Status: implemented; exact sealed engineering qualification pending.
Requirements: FR-022, FR-052, FR-053, FR-054, NFR-006, NFR-012, NFR-024.
Sources: MASTER_SPEC.md; docs/08_MEMORY_RAG_CLIENT_DNA.md;
docs/18_FEEDBACK_LEARNING.md; docs/14_SECURITY_THREAT_MODEL.md; ADR191–193.

Pending explicit instructions are process-local. Committed feedback and edit
receipts survive, but their candidate identities are generated from clock/random
state. Moderation finds a candidate in the local map before reading its durable
receipt. A restart therefore loses the queue and can make an actual saved rule
impossible to moderate. Studio feedback stores actor identity without the original
verified actor role or immutable client scope; recovery must not guess that role from today's permissions.

Persist explicit instructions in the existing immutable feedback ledger, with
stable action identity and the verified actor. Preserve the original Studio
reviewer role and client scope for new feedback; historical unknown roles stay unknown. Recover a
client-scoped candidate projection from admitted feedback/edit sources and the
latest immutable moderation receipts. Use deterministic source/pattern identities;
retain original identities for historical moderated snapshots. Client DNA remains
the only active generation authority. No second workflow or active-rule registry.

All source retrieval is already scoped under RLS. Validate stored source scope,
hashes and shapes before reconstructing evidence. Publish the reconstructed local
projection only after its read transaction completes. Source events commit before
mining; retries and reads reconcile a committed source after a failed projection.
Moderation rebuilds inside its client lock so a cold or stale Core uses current
stored evidence and decisions. Repeated source events cannot inflate frequency or
support; task-level negative polarity stays conservative. A rule's retirement must
not remove the same active text owned by another still-active reviewed candidate.

Measure recovery work and request latency against an isolated client corpus before
adding cache/queue infrastructure. This slice does not claim calibrated taste,
revision-level polarity, retroactive rights/role proof or native/human admission.
Acceptance includes independent Core processes with actual SIGKILL/restart, exact
source-key replay/change refusal, cold moderation, persisted rejection/approved
revision evidence, foreign scope, transaction failure and legacy unknown roles.

Migration076 preserves nullable historical attribution without backfilling guessed
roles or client scope, makes supported learning and Studio source events append-only,
and restricts Studio feedback reads/inserts to actual authorized client/task scope.
Membership checks use scalar subqueries as required by ADR033. Core captures the
actor/client and passes the actor through feedback history retrieval. Source/DNA/
moderation retrieval uses one SQL statement and therefore one MVCC snapshot, without
blocking a new rejection behind a pending moderation transaction. Unclassified old
sources are explicitly excluded with scoped source IDs; unknown new formats or
changed recorded hashes hold recovery. Legacy moderation receipts preserve their
stored IDs and decisions; rule approval alone never invents design approval.

Actual initial SIGKILL regression failed on28e4f0a8. First expanded33pass/2fail
caught a trigger referencing a nonexistent Studio category column and an old
fixture with no actual client member. Separate branches in the trigger and a real
member repair both; the policy was not weakened. Connected15files/131pass,
664 strict roots and lint932 any/10existing egress exceptions pass. Five full
HTTP/recovery reads over a synthetic500-source corpus took30–42ms locally, no
provider call. This is a local profiling observation, not a production SLO or
proof of unbounded scale; no new queue/cache infrastructure is justified yet.
Evidence and failures: W6_LEARNING_RECOVERY_PROOF.json. No deployment, paid call
or actual visual/native/Canva/human admission. Exact full gate remains pending.

First exact seal5e5d89c6 retained6499pass/1fail/67skip: new trigger function
inherited PostgreSQL PUBLIC EXECUTE, violating worker function admission. Revoke
that default grant; an actual runtime-role source UPDATE must still hit the
append-only trigger. Worker qualification must retain the original narrow list.
Corrected exact gate is pending; no deployment.
