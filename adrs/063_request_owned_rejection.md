# ADR 063: Terminal rejection of a request-owned design

**Date:** 2026-09-26  
**Status:** Accepted for implementation  
**Requirements:** FR-041, FR-043, FR-052, FR-060

## Context

Hawa Desk can reject a legacy task, but the request-owned review path only accepts revision requests and approvals. A reviewer cannot stop an in-review Restate-owned request without bypassing its owner. Treating rejection as `manual` or `cancelled` would misstate the decision and could admit later work.

## Decision

Add `rejected` as a terminal request stage. A signed Desk rejection carries a required category (`concept`, `content`, `brand_direction`, or `task`) and a nonempty reason. The RequestLifecycle object advances one expected revision and asks Core to atomically record the rejection, task state/event, request stage, and immutable projection receipt. Exact retries replay the stored result; changed intent conflicts. Rejection starts no delivery, revision round, or reminder. The Desk exposes the action only for a current review draft and preserves its action key across uncertain replies.

## Consequences

The database stage check and typed lifecycle state gain one value. Existing requests and legacy task review remain valid. This closes the request-owned rejection path; client/project scoped authority, feedback-ledger promotion, and live operator admission remain separate acceptance work.
