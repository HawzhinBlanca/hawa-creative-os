# ADR-161 — Owner-directed Sol 6.1 primary for the private office

Date: 2026-09-30
Status: Accepted by explicit owner instruction; deployment verification pending
Requirements: FR-056, FR-057, FR-058, FR-059, FR-060, FR-062, FR-079

## Decision and authority

After the candidate report explicitly stated that the live app still used Astra and
the larger corpus, native/blinded review and staged canary were pending, the owner
instructed: **"change astra to sol 6.1"**. Apply that instruction to production
text, layout and critique roles for this private office. This is an explicit
owner-directed exception to the FR-057 promotion sequence for this switch. It
does not assert that the unexecuted research or customer-admission gates passed.

Use the same authorized OpenAI key and exact `gpt-6.1-sol` identifier. ADR-148/149
already supply reasoning compatibility, actual pricing, conservative text bounds,
native inline-image counts, strict schema checks and durable counted-image replay.
The matched two-brief screen passed all 12 prepared layouts and observed lower cost
and mean latency; it cannot establish creative superiority or tail reliability.

Keep the existing Mini visual judge and image model. Retain Astra in the allowlist
for explicit rollback and historical receipt verification. Do not silently fall
back, rewrite old receipts, translate a saved Astra reply into Sol evidence or
repeat a paid call whose acceptance is unknown. Existing model/binding drift holds
remain active; changing defaults does not authorize consuming an incompatible old
run. Native source and human approval requirements remain unchanged.

## Execution and verification

Update the central production role registry and production allowlist. Verify the
selected role/model, budget/count behavior, strict outputs and restart/replay
guards. Seal a clean release, pass the engineering deployment preflight and use
the existing backed-up, blue/green deployment path. Read back actual live model
defaults and matching image/build identity. Record any failing or unexecuted gate
without relabeling it as passed.

The active Canva-first planner has its own durable admission/transport, separate
from the Studio client. Count its exact inline image inputs before reserving and
persist that evidence inside its existing reservation JSON as well. A counting
failure admits no completion. Use explicit low reasoning for Sol, and keep the
planner's immutable model pin and admission transaction after counting. The
generic cost preflight resolves the central text role rather than retaining an
Astra default after the switch.

Rollback is an explicit deployment of the previous release or a separately recorded
role override to Astra; it must never silently resume a Sol-bound run as Astra.
Evidence: `plans/model-migration-2026-09-30/OFFICE_SWITCH.json` (updated during work).

## Concurrent production handoff

The owner supplied `~/Downloads/NOTE_FOR_CODEX.md` during this change. Readback
confirmed production `1737c8f2` on 2026-09-30 and the `~/.hawa/current` release
link. Merge `claude/release-audit-fixes` before this switch and preserve both
traceability histories. ADR-158 release directories and shared configuration
remain authoritative for deployment; the old checkout deployment path is not
used. Other listed audit handoffs are separate work, not claimed repaired here.
