# ADR-002: Use a pinned HyCanvas release as the first editable studio candidate

**Status:** Accepted conditionally  
**Date:** 2026-09-03

## Context

The office needs a strong editable canvas with real text/layers, open portable source, exports, automation, brand support, and self-hosting. Building a complete editor is high-risk. HyCanvas v0.3.9 provides unusually broad implemented surface and current release/CI evidence, but is young and its RTL/export behavior is not yet proven locally.

## Decision

Run the mandatory Phase 0 proof against v0.3.9. Admit it only if all critical gates pass. Pin release/commit/checksum and access it only through `DesignStudioAdapter`. Maintain a neutral source manifest and fallback.

## Consequences

Potentially saves major editor engineering while preserving escape paths. Requires compatibility testing, possible office patches, and careful ELv2 compliance. No auto-upgrades.

## Alternatives considered

Penpot: mature but broader and less AI-production-native. Polotno: mature but proprietary. Custom Tela/Shotluma editor: flexible but more engineering. Artboard: too early.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
