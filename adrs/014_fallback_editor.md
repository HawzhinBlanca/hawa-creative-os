# ADR-014: Maintain an executable fallback studio path

**Status:** Accepted conditionally  
**Date:** 2026-09-03

## Context

HyCanvas may fail proof, regress, change license/maintenance, or become unsuitable. A paper fallback is not enough when editability is non-negotiable.

## Decision

Keep the studio contract, neutral manifest, Chromium HTML/SVG renderer, and a periodically tested Penpot/focused-editor migration path. Run a quarterly representative fallback reconstruction drill.

## Consequences

Prevents catastrophic studio lock-in. Some advanced features may not migrate losslessly and fallback maintenance costs time.

## Alternatives considered

Trust HyCanvas indefinitely: rejected. Build full custom editor now: too costly before proof. Use flattened exports as fallback: violates requirements.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
