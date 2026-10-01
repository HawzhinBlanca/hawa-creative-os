# ADR225 — New-row task authority and immutable selected client scope

Date: 2026-10-01. Status: implemented; focused checks pass; full release qualification pending.
Requirements: NFR-006, FR-011, NFR-011, NFR-012.
Sources: MASTER_SPEC.md invariants5/10; docs/09_MESSAGING_AND_OFFICE_INBOX.md;
docs/14_SECURITY_THREAT_MODEL.md sections1/3/5; ADR033/064/224.

## Contract and investigation

Task and derived-task policies historically authorize existing rows through
client/task membership but check only tenant identity for inserted/replaced rows.
INSERT without RETURNING must enforce actual current authority independently of
whether the new row can subsequently be read. Auditors remain read-only; unresolved
task mutations require the same requester/operator/administrator roles as the
parent task. Client scope already selected by TaskRepository.lockClientScope must
remain immutable before a native studio binding exists, including competing
transactions that both read an unresolved task.

## Decision, subject to actual reproduction

Use a forward SQL migration; keep historical schema/RLS/migration016 unchanged.
Enforce the scoped write predicate for both existing and new task rows and derived
task rows, preserving scalar membership InitPlans and current account admission.
Do not widen roles, change table/function grants, or ask a model to authorize a
write. Preserve actual policy identities and read policies where possible.
Protect a selected non-null task client at the database update boundary so a
competing initial assignment cannot replace the committed winner. Initial null
scope can be assigned once; same-client updates and unrelated task changes remain
valid. Keep application domain decisions separate from SQL enforcement.

## Required evidence

Actual restricted-role inserts without RETURNING and owner readback; assigned
designer and broad operator positives; foreign client/tenant, read-only, absent,
disabled and inactive principals; unresolved requester positives and auditor
refusals; existing/new derived row scope; initial assignment and competing actual
repository transactions; same-client updates; policy/grant/InitPlan and forward
migration integrity. Preserve failing receipts. Complete source qualification is
required; synthetic tests do not prove production-data migration, native design
quality, real publication, offsite recovery, or office pilot admission.

## Reproduction

On clean704074c1,33 strict security/scope checks fail and17 positive controls pass:
25 unauthorized no-RETURNING inserts across task/event/brief/document/audit rows;
3 auditor unresolved-task inserts;2 auditor document mutations;2 broad operator
client replacement/removal cases; and an actual repository race with two winners.
Initial33/15 included two correctly rejected append-only event mutations whose
assertion expected a zero row count; their exact append-only refusal is preserved
as a positive control. The complete33/17 failure receipt distinguishes the actual
defects. No production exploitation, row changes or native/provider work occurred.

## Connected QA evidence repair

The stricter authority exposed an existing QA handler that substituted a hardcoded
user when recording evidence, returned successful HTTP QA after storage failure,
and used the default attempt number for every rerun. Three strict HTTP/SQL checks
reproduce the identity and failure defects. After their repair, a fourth check
reproduces a concurrent rerun collision (one HTTP200 and one HTTP503).

Persist QA under the authenticated caller's current RLS authority. Lock the actual
revision row before allocating the next per-profile attempt, then append the
evidence within that transaction. Read-only callers receive403; persistence
failure receives503. Concurrent legitimate reruns remain separate numbered records.
No approval checks or visual-quality thresholds are relaxed.

Preserve ADR192/193 client-wide learning audit inserts through a purpose-specific
INSERT policy restricted to their three actions, candidate-rule resource type,
actual actor identity and current client write authority. Other non-task inserts
gain no blanket permission. The existing restrictive audit policies still apply.

Connected verification: six files/102 tests pass, including current task write
authority, forward migration identity, concurrent QA, genuine storage failures,
learning and native handoff. This is focused source evidence only. Full source,
candidate recovery and deployment qualification remain pending. See
output/qualification/2026-10-01/task-write-authority/VERIFIED_QA_SCOPE_AND_RERUN.log;
the original strict failures and concurrent collision are retained alongside it.
