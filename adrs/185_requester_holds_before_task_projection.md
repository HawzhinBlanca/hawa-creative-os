# ADR-185 — Requester holds before task projection

Date: 2026-10-01
Status: accepted; local sealed candidate qualified; live rollout pending
Requirements: FR-004, FR-005, FR-060, FR-063, NFR-001, NFR-006
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md; docs/10_WORKFLOW_RELIABILITY.md;
MASTER_SPEC.md; ADR-184.

## Evidence and decision

A hold sent during the photo/brief settlement window was deferred behind the brief.
Its eventual task was paused, but RequestLifecycle had already dispatched an unpaused
task. An eventual paused-state assertion therefore missed the first-paid-call race.

Core records a hold against the immutable original brief in the existing inbox ledger.
The original sender, chat and topic are server-owned decision metadata, outside the
untrusted Restate draft. A consumed held brief keeps its original anchor when an album
opens it. Initial task projection and early-hold acceptance share the anchor advisory
lock, acquired before the lifecycle and task locks. If projection wins first, hold
acceptance pauses its current task before acknowledging. If the hold wins, projection
creates the task and its requester pause in one transaction before returning it.

Only a clear rule-based hold with an unambiguous own pending brief is accepted here.
An explicit reply may select that sender's original brief; a foreign/unbound reply,
other sender/topic, or several possible briefs is left to normal routing. An unbound
hold is not silently applied to a pending brief while that sender has another active
design. Language siblings of the same original brief inherit its hold, because no
individual design existed when the requester held that brief.

The hold receipt retains the exact words and answer. Replays read the first receipt;
they cannot re-pause after office resume or reinterpret changed source bytes. The
existing task pause/admission/resume contract remains authoritative. RequestLifecycle
keeps the held initial acknowledgement and office alerts in its durable state and
dispatches the saved run, whose paid admissions wait under ADR-184. Already admitted
calls may finish. No new table, provider call, framework or dependency is needed.

An initial brief that falls back to manual production still creates a paused task
with a `requesterHoldBeforeProjection` checkpoint. Only its unchanged revision-one
manual owner may resume that checkpoint. This does not make later manual requests
or clarification pauses resumable through generic controls. Its acknowledgement
says paused, and the office receives the saved original words.

## Qualification

Check task state at actual worker dispatch, not only after processing the conversation.
Use the actual paid-call ledger to prove zero admissions while paused and one after
office resume. Cover replay after resume, receipt rollback, album anchor transfer,
language siblings, ownership/topic/reply ambiguity and both lock orderings. A failed
or unexecuted case remains an open gate; live deployment is a separate gate.

Tested seal cdc8e311 (source fb5051c8): full6,262 pass/0fail/2existing expected
failures/67skip; connected299 pass;650 typed roots; lint and source seal pass.
The paid-admission fixture runs at actual worker dispatch, observes zero ledger
rows while paused and one after human resume. Both lock orderings observe a real
blocked PostgreSQL backend. No provider call or hold rollout occurred.
