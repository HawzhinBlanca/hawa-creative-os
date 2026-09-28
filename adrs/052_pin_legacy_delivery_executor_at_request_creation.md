# ADR-052: Pin Legacy Delivery Executor When a Task Is Created

**Date:** 2026-09-25
**Status:** Accepted for the local R10 cutover boundary; deployed canary and restore remain open.
**Requirements:** FR-060, FR-061, FR-070, NFR-003, NFR-013.
**Amends:** ADR-034 Phase 2.2 delivery selection and the Phase 2 cutover design.

## Context

Slice 2.2 chose the Delivery workflow by reading `HAWA_LIFECYCLE_CHATS` when an operator pressed Deliver. A request created before enrolment could therefore switch executors days later, after design and approval. A publication already started had a stored owner, but an approved task with no publication did not. The R10 cutover requires existing requests to finish on their original executor.

## Decision

Every task receives an immutable `delivery_executor_pin` at creation. Existing rows migrate to `core`. New Telegram intake tasks choose `restate` only if their chat is enrolled at the task creation transaction; other tasks choose `core`. Revision, answer, reformat and reference tasks inherit a predecessor pin after the predecessor is checked against the same tenant, platform, chat and client; conflicting or out-of-scope links are refused. A RequestLifecycle projection pins `restate` regardless of the chat flag, while its own versioned delivery path remains the authority for request-owned tasks. It refuses to claim a Core-pinned predecessor. An idempotent intake replay returns the stored task and pin even if the flag has changed.

The publish route reads the stored task pin when no delivery has begun. Once a publication or requester-file command exists, that recorded effect owner takes precedence, preserving pre-migration in-flight workflow deliveries. Both the direct Core publisher and the workflow claim check the same boundary under the publication lock before starting external effects. Changing a chat flag affects only later task creations.

## Consequences and limits

- A task already approved before enrolment stays on Core delivery. An enrolled new task can finish through the existing Delivery workflow after the flag is removed.
- This pins only legacy slice-2.2 delivery. It does not activate ChatInbox lifecycle mode or complete the R07–R10 request lifecycle.
- Historical Restate publications retain their stored executor despite the migrated task default of `core`.
- The local checks do not prove a deployed canary, Restate backup restore, or real provider receipts.
