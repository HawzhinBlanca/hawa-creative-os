# ADR-092 — Durable Studio budgets across runs, clients and model roles

**Status:** Accepted for implementation; deployment admission pending  
**Date:** 2026-09-27  
**Requirements:** FR-059, FR-060, FR-062, FR-079, NFR-001

## Context

ADR-091 reserves each request within a run. A new run, another client or a second
Core process can still bypass the file-based daily controller. The earlier R03
test named PostgreSQL actually checks a JavaScript governor and file hydration;
it does not establish database concurrency or durable office limits.

## Decision

Enforce Studio admission in PostgreSQL, using the existing immutable call and
settlement ledgers, without a second spend counter. Serialize admissions, receipt
updates, settlements and policy changes with a short tenant transaction lock.
Require READ COMMITTED admission so a waiting transaction reads committed peers.
Never hold this lock during provider transport. Keep task locks before this lock.

Count today's final costs and every unresolved/estimated obligation from earlier
days. Midnight, abandonment, a new run and process restart never release unknown
spend. Use the fixed Asia/Baghdad office day, numeric USD and whole micro-dollar
reservations. A missing quote on an unresolved historical call blocks admission.
Settlements retain their original costs and release only confirmed unused funds.

Policies are append-only revisions, changed by the trusted database deployment
owner with an expected version, action UUID and reason. The database records the
connection identity and canonical limits hash. Runtime roles may read
authorized summaries but cannot rewrite policy or erase history. Bootstrap each
tenant with the existing USD 30 office daily ceiling; client and model-role
ceilings initially inherit USD 30 and can be lowered independently or overridden.
This does not import monthly demo allocations as real office policy. Zero is an
explicit spending stop. Day boundaries cannot be changed through policy updates.

Stages map deterministically to creative_director, visual_judge, asset_photoreal.
All unrecognized stages fall into creative_director, so stage spelling cannot
bypass a role limit. The database fixes the admission timestamp and records the
policy version. Desk shows the applicable daily limits and carried obligations.

## Alternatives and consequences

An in-memory/file governor is cheaper but cannot serialize multiple Core servers.
A separate counter requires reconciliation after every receipt and settlement;
reading the existing ledger removes that second source of truth. A bounded index
and aggregate query are adequate for this office; measure before adding rollups.

This milestone covers Studio text/image/vision/parity calls. Evaluation, voice and
other gateway paths still require integration before an app-wide budget claim.
Provider invoice accuracy, completed-result recovery and live release qualification
remain open. Starter policy is a rollout configuration, not authorization to spend.

## Verification

Use isolated PostgreSQL connections to race different tasks/clients against one
office remainder. Prove restart retention, day rollover, lower client/role limits,
exact usage release, overrun recording, historical missing quotes, immutable policy,
authorization and refusal before provider dispatch. Update traceability with results.
