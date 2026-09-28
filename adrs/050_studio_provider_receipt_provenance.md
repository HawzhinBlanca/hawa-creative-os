# ADR-050: Preserve Provider Receipt Provenance in the Studio Call Ledger

**Date:** 2026-09-25
**Status:** Accepted for the local R21 Studio call boundary; provider reconciliation and deployment proof remain open.
**Requirements:** FR-059, FR-060, FR-065, FR-079, NFR-001.
**Amends:** ADR-048 and ADR-049; does not change their no-blind-retry rule.

## Context

ADR-049 admits one logical Studio call before transport, and ADR-048 stops a run when acceptance or a paid current-stage result cannot safely be replayed. The text client already returns the model reported by the provider, its `x-request-id`, output hash, latency and attempt count. Generated art returns its provider request ID, output byte hash and attempt count. The ledger discards these fields. Its `model` field is the requested model, although the evidence route describes it as the answering model. This weakens reconciliation and exact-model audit, especially when an alias resolves to a different served version.

## Decision

Keep `model` as the immutable requested model, and add nullable `served_model`, `provider_request_id`, `response_sha256`, `latency_ms` and `attempts` to the tenant-scoped Studio call ledger. Finalization writes these with status and cost in the same row update. A successful text call uses its receipt's served model, request ID, SHA-256 of the returned text, latency and attempt count. Generated art uses its image-byte SHA-256 and receipt fields. Missing new provenance fields remain null; they are never invented from a requested model or elapsed-time guess. The existing `response_id` can contain a local fallback when a provider supplies no ID, so only `provider_request_id` is a trusted request-header value for provider lookup. The authorized run evidence route names requested and served models separately and exposes receipt metadata without raw prompts, responses or image bytes.

This metadata is for audit and reconciliation. A hash or request ID does not prove that an unknown call was billed, and it cannot reconstruct a successful response for stage replay. The pre-existing conservative holds remain. Persisting raw model output would require an explicit client retention policy and a separate response-store design; this ADR does not silently broaden content retention.

## Consequences and limits

- New rows can distinguish a requested model alias from the actual served model and identify a provider request during staffed reconciliation.
- Existing historical rows remain nullable and cannot be upgraded by inference.
- The receipt metadata is immutable after a completed call under the existing ledger trigger.
- No provider-side lookup, automatic replay, clean-host recovery or admission claim follows from this change.
