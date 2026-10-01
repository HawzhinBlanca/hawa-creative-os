# ADR196 — Read durable learning at its consumers

Date: 2026-10-01. Status: exact engineering gate passed; product admission open.
Requirements: FR-052, FR-053, FR-054, FR-077, NFR-006, NFR-012, NFR-024.
Sources: MASTER_SPEC.md; docs/17_UI_UX.md; docs/18_FEEDBACK_LEARNING.md;
ADR193–195; plans/content-aware-design-2026-09-30/PLAN.md.

Search still indexes the process miner although its tasks, clients and assets come
from PostgreSQL. After a crash, a saved instruction disappears until another
endpoint happens to rebuild the miner. Two legacy design consumers similarly
consult process promotions rather than active Client DNA. The DNA resolver can
also fall back to old process data after a database failure.

For database search, first resolve the authorized client set under actual caller
RLS and the requested scope/aliases. Reconstruct each selected client's rules from
the existing scoped source/moderation/DNA statement. Index that returned snapshot,
not a global projection; retain clients with no active DNA for rule search. Refuse
an incomplete database read rather than report successful search from stale memory.
Use the no-database store only when no database is configured. Label heuristic
scores as heuristics, without suggesting calibrated confidence.

For design consumers, read active DNA with the actual request/service identity;
do not substitute cached promotions or cached DNA on a failed or unauthorized
database read. Use one acquired DNA snapshot for rules and QA. Inline chat preview
remains optional after durable intake: failure skips the preview and cannot lose
or acknowledge an uncommitted request. Do not reactivate retired KAAE templates.

No new search index/cache service, queue, dependency, model call or automatic rule
activation. Source actors, immutable client scope, moderation authority and current
DNA remain owned by PostgreSQL. Acceptance includes actual independent Core/crash
search before candidate GET, current cross-process moderation, unavailable source
refusal, client isolation and existing bounded task/token search. Full exact gate
is required before publication; native/human/taste/product admission stays open.

Qualification checkpoint: cold search after actual SIGKILL failed1case (9 other
cases deliberately skipped in the focused reproduction). Connected100tests/10files
now pass,668 strict roots and lint931 any/10 existing egress exceptions pass.
Rebuilding learning is required only for rule/all search; task-only search remains
available during a rule-source read failure. Actual client memberships constrain
scoped/alias/unscoped search, including clients without active DNA. Rule status
reflects current moderation and timestamps use original evidence, not search time.

Design consumers use strict scoped active DNA and one acquired snapshot for rules
and QA. Missing/unreadable DNA holds generation; an optional preview read failure
preserves the committed request. Existing QA tests now save fixture DNA through
Core. The official Hawa test logo hashes explicit fixture bytes and differs from
the legacy generator's placeholder; original failing-QA and approval-refusal
assertions remain. Initial connected29pass/4fail,31pass/2fail,45pass/1fail and
55pass/1fail retain fixture/auth/missing-source assumptions. Initial build exposed
a shadowed request context and the QA JSON boundary; repaired without adding any.
No migrations/dependencies/paid calls or deploy. Exact sealed full gate pending.

This completes the selected consumer boundary, not all of FR077: feedback and
revision search coverage and clients without DNA as client-category hits remain
separate missing capabilities. Other legacy DNA resolver callers still permit
process fallback; only the explicit strict consumers are qualified here. Broader
W5/W6, native/Canva/human/taste and whole-product admission remain open.


Exact sealed08087d18 passes all8 engineering stages: 6523pass/0fail/67skip,
668 strict test roots, isolated newest-production-dump checks and mandatory flag
refusal pass. Connected10files/100pass and all retained failures are recorded in
W6_LEARNING_CONSUMERS_PROOF.json; exact gate in W6_LEARNING_CONSUMERS_GATE_EVIDENCE.json.
Evidence-only publication must preserve every runtime/test/migration/infra/gate byte.
Source not deployed; broader FR077/DNA fallback/native/human/taste/product remains open.
