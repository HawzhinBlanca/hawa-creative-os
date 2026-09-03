# ADR-011: Use direct Google Drive/Sheets APIs as publication adapters

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Approved files and reporting already live in Google Workspace. An automation tool between the core and Google would duplicate workflow/retry logic.

## Decision

Use Drive v3 and Sheets v4 directly. Shared Drive IDs and Sheet IDs are configured, never model-selected. PostgreSQL records saga state and a reconciler repairs divergence.

## Consequences

Precise permissions/idempotency and fewer layers. The team must implement Google-specific error/retry/reconciliation behavior.

## Alternatives considered

Apps Script: quota/runtime constraints. n8n: unnecessary core intermediary. Replace Google: no business need.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
