# ADR-007: Use ComfyUI only as an isolated visual Asset Lab

**Status:** Accepted  
**Date:** 2026-09-03

## Context

The office needs flexible local/hosted image generation, editing, cutouts, upscaling, vectorization, and reproducible pipelines. ComfyUI provides this flexibility, but community nodes are executable code and its graphs are not a business workflow engine.

## Decision

Run ComfyUI in an isolated worker with allowlisted/pinned nodes, model checksums, network restrictions, resource caps, and versioned graph manifests. It receives signed scoped jobs, not core credentials.

## Consequences

High visual flexibility and reproducibility without contaminating operational logic. Requires node governance and GPU operations.

## Alternatives considered

Direct APIs only: simpler but less composable/local. Let ComfyUI control the whole system: rejected. Build custom diffusion pipelines: unnecessary.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
