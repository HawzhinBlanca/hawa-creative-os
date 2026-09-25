# ADR-045: Distinguish uncertain requester delivery from Sheet reconciliation

**Date:** 2026-09-25  
**Status:** Accepted for implementation on `codex/research-grade-design-system`; no production cutover.  
**Amends:** ADR-043.  
**Requirements:** FR-045–FR-051, FR-060; R09.

## Context

ADR-043 keeps an uncertain Telegram requester send unresolved in PostgreSQL with `REQUESTER_SEND_UNCONFIRMED` and refuses another delivery run. The shared task status currently maps only an unconfirmed Sheet row to `PUBLISH_RECONCILIATION`; an uncertain send remains `PUBLISHING` in some views, while the publication-state route calls it `publish_reconciliation`. The Desk associates `PUBLISH_RECONCILIATION` with a “Retry Sheet Sync” button. A person can therefore receive a false recovery instruction for a message that may already have reached the requester.

## Decision

Add the read-only API status `REQUESTER_SEND_RECONCILIATION` for a `publishing` task whose latest publication has `REQUESTER_SEND_UNCONFIRMED`. Keep the database state `publishing`, the request stage `delivering`, and the publication error marker. The queue filter and task detail use the same latest publication marker so this task appears in Needs Action, separately from Sheet reconciliation and ordinary in-progress delivery. The Desk explains that staff must inspect Telegram and records, and offers no automatic Deliver or Sheet retry action. The publication-state route reports the distinct reconciliation state and a matching instruction.

This status does not settle a send, release a send mark, or claim a Telegram receipt. A later audited operator resolution must separately bind evidence and expected request revision before any replay or completion. No production flag changes here.

The operator read is scoped to the current tenant, request, task and approval. It joins the approved publication file IDs to TelegramSender's exact stable send keys and reports each latest local mark, attempt count and recorded time. The Desk shows this read-only evidence under the reconciliation state. These marks show what the worker recorded; they are not proof that the requester received or opened a message. Other roles and tasks cannot use the endpoint to inspect this chat.

A later sender hardening pass stores a positive Bot API `message_id` in a successful critical send mark and returns it on deduplicated reads. The evidence view shows that local provider acknowledgement when present, while leaving requester receipt unavailable. A success answer without a valid message ID is uncertain. A send whose final `sent` mark cannot be written after bounded retries is also uncertain, so the request cannot complete on an unrecorded provider answer. The plain-text fallback checks the same message ID and target chat as the primary path. Old `sent` marks without IDs remain readable as historical records; no ID is invented.

## Why

An uncertain external effect requires a different human decision from a missing Sheet row. Distinct status and disabled retry prevent the UI from inviting an action that the lifecycle owner correctly refuses, while preserving existing fail-closed sender behavior.

## Verification

Contract, PostgreSQL task-detail and queue, publication-state, sender-mark inspection, and Desk behavior tests must show the distinct status. A Sheet-only failure remains retryable and an ordinary publishing task remains in progress. The exact-tree release gate and traceability evidence are recorded in R09.
