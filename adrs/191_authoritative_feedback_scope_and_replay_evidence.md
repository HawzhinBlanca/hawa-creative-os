# ADR191 — Authoritative Studio feedback scope and replay evidence

Date: 2026-10-01. Status: accepted for implementation; qualification pending.
Requirements: FR-022, FR-052, FR-053, FR-054, NFR-006, NFR-012.
Sources: docs/18_FEEDBACK_LEARNING.md, docs/08_MEMORY_RAG_CLIENT_DNA.md,
MASTER_SPEC.md, ADR012; W6_CLIENT_ATTRIBUTION_FINDING.json.

The Studio feedback route authorizes a task/run/candidate join but omits its client
when invoking the miner. The miner substitutes a fixed KAAE identity and invents an
art-director role when absent. Replaying an event increments frequency, and approving
an unrelated task supplies positive evidence to every rule for that client.

Bind the client from the authorized database task, never the request body. Require
an explicit client in the miner; reject conflicting context before changing state.
Validate an entire import batch before accepting any event. Remember event identity
and canonical content within the process: exact replay is inert, changed reuse refuses.
Do not infer actor authority. Positive evidence may support only a rule already
linked to that task, and negative evidence may affect only its client. Mine only after
the feedback transaction commits, so a rolled-back row cannot create a proposal.

PostgreSQL feedback and the route's durable idempotency remain authoritative. This
process-local projection is not durable taste training or exactly-once delivery across
crashes. No existing proposal is retroactively reassigned or promoted: historical
provenance, persistent rebuilding, revision-level negatives, scope interpretation,
independent-task pattern clustering and human calibration need separate qualification.

Acceptance: non-KAAE actual HTTP submission with a spoofed body client still produces
only the task-client proposal; authorized actor role is preserved. Missing/conflicting
scope and changed replay refuse without partial batch effects. Exact replay leaves
frequency and negative counts unchanged. Unrelated approvals do not manufacture
support, and another client's rejection cannot change a rule. Retain initial failures,
connected tests, types and exact engineering gate evidence; no human-quality claim.


Qualification, 1 October 2026: clean seal01676ef4 passes all eight engineering
stages,6464 tests/0 failures/67 skips,660 typed roots and newest-dump invariants.
The initial failures and corrected required-fixture-field type failure remain in
W6_FEEDBACK_ATTRIBUTION_PROOF.json. This is source qualification, not deployment,
durable taste learning, historical promotion provenance or native/human admission.
