# ADR-013: Prefer direct model-provider adapters over a universal gateway

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Image and frontier providers differ in snapshots, multimodal inputs, editing controls, caching, safety, errors, and provenance. A generic gateway can reduce these to a lowest common denominator.

## Decision

Implement narrow provider adapters behind `ModelGateway`/`AssetProvider`. A gateway may be added for commodity text fallback only if evaluation proves value.

## Consequences

Preserves exclusive/new capabilities and exact error semantics. Requires several small adapters and provider credential management.

## Alternatives considered

OpenRouter/gateway for everything: easier but capability/observability risk. One provider: lock-in. Raw SDK calls throughout code: prohibited.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
