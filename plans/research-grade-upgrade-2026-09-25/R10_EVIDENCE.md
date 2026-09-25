# R10 — Legacy delivery cutover pin

**Date:** 2026-09-25. **Status:** in progress. **Branch:** `codex/research-grade-design-system`. **Decision:** ADR-052. **Requirements exercised:** FR-060, FR-061, FR-070, NFR-003, NFR-013. Linked contracts: `docs/10_WORKFLOW_RELIABILITY.md`, `docs/14_SECURITY_THREAT_MODEL.md`, `MASTER_SPEC.md`; earlier slice design in `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md`.

## Finding and local change

An approved legacy task with no publication was assigned its delivery executor by the live `HAWA_LIFECYCLE_CHATS` setting when the operator pressed Deliver. An old request could cross to Restate after enrolment; a new enrolled request could cross to Core after a rollback. Only tasks with an already-started publication had a durable executor. The R10 acceptance rule requires old requests to finish on their original executor.

Migration 031 adds an immutable `tasks.delivery_executor_pin`; historical tasks default to `core`. A new Telegram task samples chat enrolment at creation. A revision, answer, reformat or reference task inherits the predecessor's pin after checking tenant, platform, chat and client scope; contradictory or missing predecessor links fail closed. The lifecycle projection pins its own new tasks to Restate and refuses to claim a Core predecessor. Replaying the same intake event returns the original task and pin. The publish route uses the stored pin before the first effect. A recorded publication or Core requester-file command retains its owner, including an in-flight historical Restate publication whose migrated task row defaults to `core`. The direct Core publisher and the workflow claim both check the stored choice before taking external effects.

## Verification

The disposable local PostgreSQL databases were rebuilt because a previous migration 030 checksum did not match this checkout. Versioned migration 031 applied to both. Focused cutover, intake and schema checks passed **4 files / 33 tests**; the new tests cover both chat-flag directions, first Deliver, direct Core refusal, idempotent replay, immutable pin, revision/answer/reference inheritance and scope refusal. TypeScript and tests typecheck passed. The first broad source run found **5 fixture failures** in three files: tests had linked revisions to a different random chat or client. Those fixtures were corrected to represent one request chain; the affected **3 files / 31 tests** passed. The corrected broad source run passed **421 files / 3,221 tests**, with **4 files / 48 tests skipped**, excluding only the manifest-dependent release-gate file. Lint passed with no new direct provider egress and the security scan found zero secrets in committable files. Exact-candidate sealing checks are recorded after the source commit.

## Remaining R10 acceptance work

This change pins legacy slice-2.2 delivery. It does not complete ChatInbox routing of an old request through a flag transition, including callback updates and late answers; it currently refuses a lifecycle projection that tries to claim a Core predecessor. No deployed canary, Restate backup/restore, clean-host recovery, real provider receipt, or full rollback drill was performed. `R10` stays in progress, and both production design flags stay off. These local checks do not establish a 10/10 production system.

## Sealed source checkpoint

Source and evidence commit `5a101e944700c4d5940e451516e22bf8404c0437` was sealed by `e78238f860873c05d11b6ed7e0564ec6d67a3770` with source-candidate manifest SHA-256 `bcf2966e2c7b5fd040800d04417130911e8d5945e7b30bd21a0e51c04e1d2a7b`. The clean exact-candidate suite passed **422 files / 3,227 tests**, with **4 files / 48 tests skipped**. The manifest verifier passed; six release-gate refusal controls passed separately; blueprint validation passed **779 checks / 0 warnings / 0 failures**. The admission assessor returned `UNQUALIFIED_ENGINEERING`, with Gates A–H each `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest records migration 031, unbuilt components and both design flags off. This is a source checkpoint, not a deployed release.
