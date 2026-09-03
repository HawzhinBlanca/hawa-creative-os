# ADR-010: Use OpenTelemetry and self-hosted Phoenix for AI observability/evaluation

**Status:** Accepted  
**Date:** 2026-09-03

## Context

The office needs provider-neutral traces, prompt/model comparisons, datasets, and evaluations while retaining ownership. Workflow logs alone cannot explain retrieval/model/visual quality.

## Decision

Instrument all components with OpenTelemetry and self-host Phoenix. Keep authoritative admissions/audit in PostgreSQL so Phoenix remains replaceable.

## Consequences

Strong model experimentation and trace evidence without SaaS lock-in. Adds one service and data-retention duties.

## Alternatives considered

Langfuse: strong alternative. Vendor-specific observability: too narrow. logs only: insufficient.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
