# ADR224 — Current account and tenant membership for stored resource authority

Date: 2026-10-01. Status: reproduced; implementation and qualification pending.
Requirements: NFR-006, FR-011, FR-018, FR-064, NFR-012.
Sources: MASTER_SPEC.md invariants5/10; docs/14_SECURITY_THREAT_MODEL.md sections4/5;
docs/17_UI_UX.md stored search; docs/29_ACCEPTANCE_GATES.md GateB; ADR033/064/223.

## Reproduction and contract

A real named-session Core request still downloads a retained original after the
user's tenant membership is deactivated. Runtime RLS also returns task rows to
disabled designers and operators; direct write probes use separate strict tests.
The initial three failing tests and subsequent complete red receipt are retained.
A client grant and a cached principal are not independent office admission.
ADR064 requires enabled pre-provisioned accounts and active tenant membership;
current data authority must enforce their removal without waiting for session
refresh or requiring every route to implement a different check.

## Decision

Amend the existing SQL membership helpers through a forward migration: tenant
membership and tenant-role checks require an enabled user; client read/write
helpers and the hoisted client-ID set require active enabled tenant membership.
Client role restrictions and broad tenant roles retain their existing scope.
The current persisted membership is read at each statement, including warm/cold
Core sessions and retained/forged application role strings. No session cache,
network/provider/worker grant, role expansion, permission table or dependency is
added. Account restoration or explicitly renewed membership restores existing
client scope; client grants alone cannot override disabled office admission.

Preserve ADR033's once-per-statement policy shape: use a scalar admission subquery
inside member_client_ids and leave policies unchanged. Preserve function identity,
owner, security-definer/search-path/STABLE properties and ACLs with CREATE OR
REPLACE. Do not edit historical schema/RLS/migration016 files or regenerate its
hash-guarded historical policy rewrites. The client-only designer fixture must
now include actual active office membership; its positive and foreign-client
negative assertions remain intact. This intentionally tightens historical client-
only admission to the current ADR064 office contract.

## Required qualification

Actual named sessions and runtime database roles: active positive reads/writes,
foreign tenant/client refusals, inactive/deleted tenant membership with retained
client grants, disabled broad and client roles, direct/hoisted helper equivalence,
role-restricted writes, reactivation, missing identity and membership, statement
plan/ACL/worker grant checks. Verify all affected and complete source suites and
fresh candidate nginx/worker boundaries with the new migration and source hashes.
Retain failures. Production-data migration check, production deployment and whole
native/human/model/pilot admission remain separate and unproven.
