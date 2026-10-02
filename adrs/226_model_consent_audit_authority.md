# ADR226 — Scoped administrator model-consent audit insertion

Date: 2026-10-01. Status: exact integrated source and synthetic deployment/recovery qualified; whole product admission open.
Requirements: NFR-006, FR-056, NFR-011, NFR-012.
Sources: MASTER_SPEC.md invariants5/8/10; docs/14_SECURITY_THREAT_MODEL.md;
ADR225/234; current release integration proof.

## Actual integration defect

The current live branch adds administrator-approved model-consent changes to client
DNA. Its append-only audit has no task. Removing the historical tenant-only INSERT
bypass in forward080 therefore correctly refuses the unscoped row, but also rolls
back legitimate consent changes. The first integrated full source run has7515
passing/4 failing/67 skipped tests: three failures are this transaction and its
dependent replay/withdrawal assertions. A fourth is an old approved-palette fixture.
The original failures are retained; no production consent change was attempted.

## Decision

Add forward081, leaving qualified080 and all historical hashes unchanged. Supply
only the two consent audit actions with an explicit permissive INSERT path plus a
restrictive guard that prevents another task policy authorizing forged consent
records. Require current enabled office administrator membership, actual user
actor identity, no task, a matching client/tenant DNA version approved by that
actor, and matching after-hash. Preserve every existing read policy and grant.
Existing application checks still require a human administrator and serialize
the DNA revision; this policy does not turn a service into an administrator.

Verify real restricted-role inserts, legitimate authenticated HTTP consent,
replay and withdrawal, forged roles/actor/source/task/hash, revoked accounts and
office membership, and repeatable forward policy identity. No broader audit role
or tenant-only write bypass is restored. Full integrated source/recovery gates
and production-data/native/human acceptance remain separate obligations.


The two policies also bind grant/withdrawal to the actual stored privacy mode and
provider-array state. Six files/38 checks pass, including16 strict SQL authority
and migration identity controls, real administrator API/replay/withdrawal,
startup/upgrade inventory and actual requested-background/render QA. No permission
or QA assertions were relaxed. Five isolated candidate controls exercise the
current source-bound permission, refusal and081 checksum; execution is pending.


## Exact qualification — 2 October 2026 (Asia/Baghdad)

Clean1cf34fdb:7535/0/67 source tests,716 passing files,723 strict roots; seven
technical stages and negative flag refusal pass. Production-data Stage3 remains
NOT_RUN pending explicit transfer approval. Exact6647a4cb candidate237/0, including
five consent controls; two encrypted105-table/179-policy/16-blob restores with
zero missing references. Source/candidate runtime, migration and harness match;
only a test catalog result-type annotation and seal differ. Every failure retained.
Owned synthetic stack removed; production remainsbaffce10 and was not deployed
by this work. Real native/human/offsite/pilot admission remains open.
