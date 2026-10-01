# ADR197 — Client DNA reads cannot recover through privileged process memory

Date: 2026-10-01. Status: implementation; qualification pending.
Requirements: FR-021, FR-046, FR-047, FR-049, NFR-006, NFR-012, NFR-024.
Sources: MASTER_SPEC.md; docs/08_MEMORY_RAG_CLIENT_DNA.md;
docs/13_GOOGLE_DRIVE_SHEETS.md; docs/14_SECURITY_THREAT_MODEL.md; ADR196.

With PostgreSQL configured, the shared DNA resolver currently substitutes its
administrator-hydrated map when a scoped query returns no row or fails. The detail
route repeats a failed read before making this substitution. This can disclose
another client's DNA and resurrect an obsolete publication destination.

Require an explicit caller or server identity and return only scoped active SQL
DNA. Missing or inaccessible rows stay missing; failed authority acquisition is
503, without exposing SQL diagnostics. Canonical identity/version fields come from
the row, not the stored JSON. The process map remains a no-database test store.
Do not retry client writes outside RLS or derive a database version from memory.

Pass the actual identity and existing transaction at task/rubric/review consumers.
Server delivery uses its explicit automation identity. A new publication needs
current authoritative DNA; a retry uses its immutable publication expectation,
freshly checked approved bytes and original file names/destination. Completed
answers use actual stored Drive/Sheet receipts, without consulting current DNA.
No new cache, dependency, credential, provider call or automatic approval.

Acceptance: real client memberships and warmed cache cannot reveal foreign UUIDs
or aliases; an actual SQL privilege failure cannot become a successful cached
answer or provider call; scoped current/canonical reads and the no-database store
remain supported; frozen publication replay and stored completion links remain
stable after DNA changes. Preserve all failed checks and qualify the exact source
through the existing release gate before publication. No aesthetic admission or
deployment follows from these synthetic engineering checks.


## Authoritative DNA consumer boundary — 1 October 2026, ADR197

Actual warmed-cache denial, default-operator impersonation, SQL read failure and
JSON scope/version overrides reproduced four failures. Scoped PostgreSQL is now
the only configured-database DNA authority. Caller identities reach rubric,
review and publication task reads; writes never retry outside RLS. Frozen
publication replay preserves original inputs, including the permitted first
reporting-Sheet binding; completed links use actual stored receipts.

Retained all intermediate failures and the unsealed development full precheck.
Its84 failures exposed old cache-only setups and one first-Sheet replay control;
it is not an exact-source qualification because development continued during it.
Explicit durable fixtures preserve original approval/QC/recovery assertions and
the deliberately DNA-less search control. Connected62pass; crash/replay20pass;
affected consumers206pass/3fail/1skip, corrected remaining26pass. Counts overlap.
Actual deferred DNA commit refusal preserves the active version. Exact full gate
pending. W6_DNA_AUTHORITY_PROOF.json. No deployment or aesthetic admission;
broader search/direct-map/W5/W6/native/Canva/human/product gates remain open.
