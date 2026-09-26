# ADR-060: Bind RequestLifecycle images to the owned task

Date: 2026-09-26
Status: accepted for implementation
Requirements: FR-011, NFR-006
Sources: `MASTER_SPEC.md` §§2, 5, 6, 10; `docs/09_MESSAGING_AND_OFFICE_INBOX.md` §§5, 8; `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §2.1; `plans/research-grade-upgrade-2026-09-25/PLAN.md` G2.

## Context

The legacy Studio can look for unbound photos near a task in the same chat and infer
their owner from time and repeated words. A request-owned task has a fixed client and
request identity before Studio runs. A nearby photo has neither identity, so the
legacy inference can introduce content from another request into an owned design.

## Decision

When `hawa.tasks.request_id` is set, Studio reads image inputs attached to that
task's creation event only. It does not search nearby chat tasks, late unbound
photos, or previous messages with the same words. Existing Core-owned tasks keep
the legacy behavior while cutover is incomplete. Any future lifecycle photo or
album intake must save an explicit, request-bound reference before DesignRun starts;
the worker journal carries only its identity, never image bytes.

## Consequences

A lifecycle design cannot silently absorb an unbound image. If an image has no
verified request link, intake holds it for office follow-up under ADR-059. This is
an isolation guard, not completed media admission: durable download, blob retention,
album grouping, voice/PDF use and a killed-process replay still need their own
implementation and evidence before lifecycle media is enabled in production.
