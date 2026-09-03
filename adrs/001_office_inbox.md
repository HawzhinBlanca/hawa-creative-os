# ADR-001: Make Hawa Desk the canonical office inbox

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Tasks currently originate in chat groups, but no chat product provides durable office-specific state, complete permissions, editable review, model evidence, or publication reconciliation. Choosing a channel as the center would force the office to inherit its availability and interaction model.

## Decision

Build Hawa Desk as the canonical task, review, Client DNA, and operations interface. Telegram, WAHA/WhatsApp, Slack, email, and future channels implement `MessageAdapter` and never own workflow state.

## Consequences

Channel outages cannot erase task state; the office gets a purpose-built UI; one custom interface must be maintained. Adapters can be replaced independently.

## Alternatives considered

Slack-first: common but office-misaligned. Matrix migration: powerful but unnecessary behavior change. Telegram-only: too narrow. Chat-as-database: rejected.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
