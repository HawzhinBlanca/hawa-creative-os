# ADR-040: Authenticated Desk Decisions Enter the Private RequestLifecycle Through a Narrow Gateway

**Date:** 2026-09-25
**Status:** Accepted for implementation on `codex/research-grade-design-system`; no production cutover.
**Amends:** ADR-034 section 2.3 (how Desk asks the private request object to decide).

## Context

`RequestLifecycle` is private to Restate service calls. Core's authenticated Desk route cannot invoke it through public ingress. Making that entire object public would expose its open, design-finished and state handlers. Writing a Desk approval straight to PostgreSQL would leave the object's stage behind, recreating two authorities.

## Decision

Add one public, stateless `OfficeDecisionGateway` Restate service. Core verifies the signed-in user and allowed office role, reads the task's persisted request owner, and sends only a versioned revision request with the existing Desk UUID action key. Core signs the exact event with the shared worker credential under a domain-separated HMAC. The gateway verifies the signature in constant time and then calls the private `RequestLifecycle.officeDecision` handler. The object and Core projection check the expected revision and current draft and keep the role, task version and hash-bound receipt fences. Core deliberately forwards a retry after the request has advanced, so the object can return the original result for the same action key. Missing credentials or Restate ingress fail closed; the Desk never reports a decision until a committed result is returned. Retrying the same action key returns the same approval; changed content is a conflict.

The gateway name is permanent in the worker service inventory for blue/green compatibility. It admits only this decision shape. Approval, rejection, later rounds and chat actions require their own explicit contracts and tests. Keep lifecycle chat flags off until the wider request loop and deployed recovery gates pass.

## Why

The narrow service gives Core one authenticated path into the private request owner without exposing other lifecycle methods. The signed event prevents a caller of Restate's public ingress from asserting a reviewer identity. The request object's existing serialization and PostgreSQL projection keep one authority for task, approval and request state after network loss or retry.

## Alternatives

- Publicly expose the whole RequestLifecycle object: too broad an ingress surface for its internal report and state handlers.
- Write the approval directly in Core: the object's state would not advance with the database, so the next event could act on stale stage.
- Reuse ChatInbox as an office gateway: it keys by chat and would mix unrelated identity and ordering domains.
