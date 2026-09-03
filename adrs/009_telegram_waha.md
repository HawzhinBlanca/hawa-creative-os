# ADR-009: Use Telegram first and WAHA only as an isolated optional WhatsApp adapter

**Status:** Accepted  
**Date:** 2026-09-03

## Context

The office uses group messaging and may prefer WhatsApp/Telegram. Telegram has an official programmable surface; existing WhatsApp group ingestion often requires an unofficial client path.

## Decision

Implement Telegram Bot API/Mini App first. Add WAHA only with a dedicated account, isolated boundary, reconciliation, read-only/default promotion controls, and kill switch. Neither is canonical.

## Consequences

Fits real office behavior without forcing Slack. WAHA introduces account/compatibility risk, contained by architecture. Staff can always use Hawa Desk.

## Alternatives considered

Slack-first: misaligned. Official WhatsApp only: may not expose existing groups as needed. Matrix migration: too much organizational change.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
