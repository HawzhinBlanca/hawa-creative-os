# ADR-006: Resolve AI by evaluated role through a versioned model registry

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Frontier models and prices change rapidly. A permanent provider choice would age quickly and one model is not best across routing, creative direction, judging, images, and retrieval.

## Decision

Every AI call requests a semantic role. The registry resolves an exact tested model/deployment/prompt/tool profile, fallback, budget, and egress policy. Promotions require offline evaluation, shadow, canary, and rollback.

## Consequences

Future models can be adopted without architecture changes. Evaluation work becomes a permanent operating responsibility. Rolling aliases are prohibited unless explicitly accepted.

## Alternatives considered

One universal model: simpler but lower quality/resilience. OpenRouter/gateway-first: convenient but can hide provider-specific capabilities and errors; may be optional later.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
