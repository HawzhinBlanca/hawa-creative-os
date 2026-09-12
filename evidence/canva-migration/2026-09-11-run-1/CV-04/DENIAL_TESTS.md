# Denial & Invariant Test Evidence: Canva Studio Binding & Capture Contracts

**Audit Date:** 2026-09-11  
**Task:** CV-04  
**Governing Invariants:** Invariant #1 (Server-Derived Ownership), Invariant #3 (Cross-Tenant Isolation), Invariant #5 (Snapshot Completeness)  

---

## 1. Requirement & Threat Model Context

Under the Canva integration model, Hawa delegates interactive editing to native Canva but retains strict sovereign governance over client identity, task scoping, and release artifacts.

A critical vulnerability in multi-tenant creative platforms is **client confusion** or **authorization bypass via URL injection**: an operator or attacker might supply a valid Canva design URL belonging to Client A (`KAAE`) while processing a task for Client B (`FastPay`), causing proprietary brand materials or confidential campaign content to be ingested into the wrong client's archive or delivered to the wrong Google Drive folder.

Furthermore, representation of **partial or incomplete layer snapshots** as authoritative sources risks delivering corrupted or half-baked creative deliverables.

To eliminate these failure modes at the boundary contract and database levels, CV-04 implements and proves five strict denial controls:

---

## 2. Invariant Denial Matrix & Verified Proof

| Invariant / Denial Test | Threat Prevented | Enforcement Layer | Test Proof & Status |
|---|---|---|---|
| **Server-Derived Client Ownership** | Design URL alone selecting or switching client context | `validateCanvaCaptureInvariants` + `CanvaBindingRepository.createBinding` | `FOREIGN_CLIENT_DENIAL` returned; tested in unit & live DB (**PASSED**) |
| **Cross-Client Design Collision** | Re-binding an existing Canva design to a foreign client | `CanvaBindingRepository.createBinding` unique index + check | `Foreign client denial: Canva design ... is already bound to client ...` (**PASSED**) |
| **Design ID Spoofing / Mismatch** | Submitting an arbitrary foreign design ID against an existing binding | Contract validator + `CanvaBindingRepository.captureArtifactSet` | `UNKNOWN_DESIGN_DENIAL` / `Design mismatch denial` (**PASSED**) |
| **Optimistic Concurrency / Stale Request** | Race conditions between concurrent captures or overwriting newer versions | `expectedVersion` checking against atomic database row version | `STALE_VERSION_CONFLICT` / `Stale version conflict` (**PASSED**) |
| **Snapshot Incompleteness Denial** | Representing unobserved or partially parsed layers as a fully observed source | Contract validator + repository assertion (`semanticCoverage.isComplete`) | `INCOMPLETE_SNAPSHOT_ERROR` / `Snapshot incompleteness denial` (**PASSED**) |

---

## 3. Live PostgreSQL Drill Execution

The test suite `packages/db/test/canva-binding.integration.test.ts` was executed against live PostgreSQL database `hawa_test` (port `54332`):
- Clean task fixture created under tenant `00000000-0000-4000-a000-000000000001` and client `kaae` (`c1000000-0000-4000-8000-000000000002`).
- Binding inserted into table `hawa.canva_bindings`.
- Cross-client capture attempt with client `fastpay` (`c1000000-0000-4000-8000-000000000004`) was denied with `Foreign client denial`.
- Stale version capture attempt was denied with `Stale version conflict`.
- Incomplete semantic coverage attempt was denied with `Snapshot incompleteness denial`.
- Valid capture set was committed into `hawa.canva_capture_sets`, atomically bumping `hawa.canva_bindings.version` to 2.
- Production database `hawa` verified row-for-row untouched (exactly 1,449 tasks, 0 test contamination).
