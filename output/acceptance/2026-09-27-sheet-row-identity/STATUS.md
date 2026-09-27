# Stable Google Sheet row identity — local implementation checkpoint

2026-09-27; ADR-105; FR-049 and prerequisite to FR-050.

## Changed

- Exact configured tab propagated from Client DNA through provider request, receipt validation, database write and staff link.
- Bounded numeric-tab reads, duplicate-task detection, full row-value/hash verification.
- Provider metadata binds tenant, spreadsheet, tab and immutable task. Atomic insert/write/metadata creation; exact metadata-filtered RAW updates. No blind append or cached numeric-row writes.
- Lost successful responses and process restarts recover the original row. Concurrent payload/destination mismatches refuse a shared in-flight result.
- An accepted write with unavailable readback retains expected values and remains unconfirmed until later independent verification.

## Verification

Final affected acceptance: **440 passed, 0 failed**, 39 files, 8.25 seconds. Includes all integration adapters, selected Core delivery/reconciliation/concurrency checks and fake-service contracts. Includes an actual child-process SIGKILL after row creation but before response delivery, followed by a fresh process recovering exactly one row/metadata identity. These counts overlap; do not add the drill separately.

Repository source build, strict test compilation (**509 roots**), scripts/lint (965/1053 any ceiling; 9 existing egress exceptions), zero-secret scan and 11-pattern scanner self-test pass. No full-suite rerun or new release seal is claimed for this implementation checkpoint. The last sealed full suite remains ADR-104's 4169 tests on its own source. No new deployed image or real Google call was made.

Four original-adapter red regressions: wrong tab, accepted duplicate task, missed changed Drive link, and changed cached destination tab. A separate Core regression proves hardcoded tab 0. Original sandbox denial and failed compatibility fixtures are retained. The initial concurrency error omitted required AppError fields; source/test compilation caught it and the fields were repaired. A later fixture expected missing expectations after the implementation started preserving them; it now represents a truly absent remote row and passes.

## Open

FR-049 remains open for supervised migration of legacy unbound rows, the full reporting column schema and live provider qualification. FR-050 remains open for immutable PostgreSQL publication inputs/row expectations, durable scheduled external observations and scoped staff repair. The old receipt-ID-only reconcile API remains process-local. Current seven-column row evidence is returned but is not yet stored in PostgreSQL. Permission baselines remain unimplemented rather than fabricated. Full final-source regression/deployment, real office/provider/Canva, multilingual/design quality, independent-host restore/monitoring and controlled rollout remain open. Production is unchanged; whole-app goal stays active.
