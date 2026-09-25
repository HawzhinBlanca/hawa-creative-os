# ADR-042: Bind request-owned approval to the exact QA run and captured exports

**Date:** 2026-09-25  
**Status:** Accepted for the research-grade branch; no production cutover.  
**Amends:** ADR-040 for the first request-owned `approve` action.  
**Requirements:** FR-041, FR-043, FR-044, FR-060; R08 and R17.

## Context

The signed Desk gateway and private RequestLifecycle object currently admit only the first `revise` action. The ordinary Desk approval route validates the latest passing critical QA run and selected stored exports, while request-owned tasks deliberately cannot use that legacy writer. Treating `approve` as an alias for `revise`, or writing an approval directly in Core, would split the request state and decision ledger. A retry after a committed approval must still name the original QA run and exports even if a later capture changes what “latest” means.

## Decision

Extend the existing signed event with `approve` and a bounded proof containing the exact QC run ID/report hash, immutable stored export IDs/hashes/sizes/formats, and any required RTL visual sign-off. Core derives the proof from PostgreSQL and stored bytes after authenticating the Desk actor. The private projection locks the request and task, requires revision 2 and the current draft, and asks the approval repository to recheck the latest passing critical QA and exact Canva capture/binding inside the transaction. It stores the proof and the submitted Desk-body fingerprint in the append-only approval. A retry with the same action key and body reuses that stored proof and still passes through RequestLifecycle for a hash-bound replay; changed intent is refused. Approval advances the request to `approved` and records no publication side effect. Delivery requires its separate versioned transition and proof.

The first approval contract allows only office art/creative directors and office administrators. Client approvers and account leads require separately proved client/project authority. Missing QA, missing bytes, stale version, mismatched capture, uncertain gateway response and unavailable provider state fail closed. The existing first-revision request event remains compatible with signed invocations already in flight.

## Why

The office must approve the bytes and QA it actually inspected, not whatever a retry or later read discovers. PostgreSQL remains the decision authority, and Restate remains the sole request lifecycle owner. A stored proof preserves idempotent recovery across a lost Desk response without granting the browser control of hashes or actor identity.

## Limits

This does not establish final PNG visual quality, live Canva state after the capture, approved delivery, a deployed worker restart, or a requester receipt. Those remain separate admission gates.
