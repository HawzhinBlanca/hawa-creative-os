# ADR195 — Attribute learning examples to the reviewed design

Date: 2026-10-01. Status: connected acceptance passed; exact engineering gate pending.
Requirements: FR-022, FR-052, FR-053, FR-054, NFR-006, NFR-012, NFR-024.
Sources: MASTER_SPEC.md; docs/08_MEMORY_RAG_CLIENT_DNA.md;
docs/18_FEEDBACK_LEARNING.md; docs/14_SECURITY_THREAT_MODEL.md; ADR191–194.

The miner remembers rejection by task forever. Studio already records run,
candidate and sometimes picture hash, and approved edit sources already identify
both immutable revisions. Discarding these targets wrongly contaminates a later
corrected design. A high rating also becomes approval for unrelated rule support.

Use immutable reviewed target receipts: candidate/run/picture hash, or revision/
source hash. Preserve explicit task-wide rejection for the task-level endpoint;
allow a caller to name a stored revision instead. Exact-target negative evidence
blocks that target, without rejecting a different corrected design. A rating is
an observation, not an approval. Attach rule support only to the actual source
or verified approved revision pair; approval of another design in the same task
is not proof that a rule is useful. Keep source actor and approval actor distinct.

Recover target receipts from PostgreSQL before mining/moderation. Require the
inspected preview hash for new Studio feedback; old source rows without a target
remain unverified and never create positive examples. Exact legacy action replay
must not manufacture new target evidence. Keep stable IDs, actual scope, original
roles, source hashes and action identity. No additional workflow/cache authority,
no automatic rule activation, prompt changes or fine-tuning.

Examples expose exact source/target receipts and positive/negative summaries.
Heuristic rule scores must not be displayed as calibrated confidence. Human review
can inspect the evidence. Test independent targets, changed picture/hash reuse,
ratings, paired revisions, source/approval attribution, task-wide holds, restart,
failed commit, foreign scope and concurrent moderation. A corrected source becomes
positive only through explicit verified approval, not its clock/order or a model.

Known separate boundary: search and retired inline previews still consume the
process projection directly. Verify and repair those consumers separately; this
ADR does not claim their cache dependence is resolved or whole-product admission.

Native decision feedback is also reconstructed against the actual same-tenant/task/client
approval, deciding actor, stored revision source and bound passing QC/source hash for
approvals. Historical decisions with no matching authority are excluded explicitly.
Migration077 protects decision/rejection source categories (including category changes
into a protected source) without editing published076 or granting the worker EXECUTE.

Qualification checkpoint: six baseline failures retained; first connected102pass/18fail
revealed a SQL text/UUID comparison; next122pass/1fail exposed repeated wide-hold
receipt fan-out timing out a real500-source HTTP recovery. Both repaired without
raising the10-second request bound or changing eligibility. Final19files/169pass,
667 strict test roots, source/Desk build and lint pass. Actual separate-process
SIGKILL/replay, source immutability, native authority/hash refusal, actor separation,
foreign task and UI distinct-target controls are included. One original receipt per
task-hold basis plus each rule's own source proves the same hold without copying
every hold into every candidate. Full source histories stay in PostgreSQL.
Local five-request500-source profile77–82ms; not a production SLO or taste study.
W6_TARGET_BOUND_LEARNING_PROOF.json records hashes and retained failures. No deploy.
