# ADR-004: Use Restate for durable workflow execution

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Tasks include long model calls, asset generation, human waits, retries, editor operations, and multi-system publication. A visual automation tool or hand-built queue would require extensive custom recovery logic.

## Decision

Self-host Restate 1.7.x and implement a single task workflow with durable services. Protect ingress through a PostgreSQL inbox/outbox and preserve application-level idempotency at every external side effect.

## Consequences

Strong restart/replay semantics and human waitpoints with low infrastructure count. The office must operate Restate and understand journals. Restate does not remove external idempotency requirements.

## Alternatives considered

Temporal: strongest but heavier. Trigger.dev: good hosted alternative but less office-owned. n8n: useful connector, weaker core state model. custom queue: false simplicity.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
