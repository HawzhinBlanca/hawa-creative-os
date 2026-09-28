# R15 — Governed feedback evidence

**Date:** 2026-09-26. **Status:** in progress. **Requirements:** FR-042, FR-052, FR-053, FR-054, FR-055.

## First pass — review decisions produce atomic feedback

**Source:** `packages/db/src/repositories/revision.repository.ts`, `packages/db/test/approval-task-state.test.ts`, `apps/core/test/lifecycle-design-outcome.test.ts`, and `apps/core/test/lifecycle-office-desk-bridge.test.ts` (2026-09-26).

The shared revision repository now writes one structured `feedback_events` row inside the same transaction as a client-scoped approval, revision request, or rejection. It records the task/client/project, reviewed revision, reviewer, decision/category, bounded severity, one-time scope, reason, and exact approval ID in the target. A revision request retains its structured feedback payload; a rejection retains its concept/content/brand/task category. The reusable marker remains evidence only and never activates a Client DNA rule. Request-owned reviews fail closed if the task lacks a resolved client; legacy clientless decisions remain a separate gap because `feedback_events.client_id` is mandatory and inventing a client would violate scope.

Red-before isolated PostgreSQL checks showed missing rows for direct decisions and a request-owned rejection (2 failing tests). Green focused tests passed **3 files / 24 tests** after rebuilding `@hawa/db`; an intermediate Core failure had loaded stale built package code. The tests cover all three decision types, exact request-owned rejection and approval retry with one feedback row, and a forced feedback write failure rolling back the approval, task state and design event. The full source suite excluding only the unsealed release gate passed **425 files / 3,300 tests**, with **4 files / 52 tests skipped**. Typecheck, lint and the security scan passed; blueprint and exact sealed release checks follow this evidence checkpoint.

**Limit:** This does not cover every manual edit, requester correction, inferred feedback, rule proposal/acceptance, or legacy clientless decision. The required human-approved rule activation and live learning evaluation remain open; R15 is **in progress**.
