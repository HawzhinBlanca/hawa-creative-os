# ADR-072: named approval and durable search of retained PDF evidence

Date: 2026-09-26. Status: accepted for implementation; release admission remains separate.
Requirements: FR-018, FR-019, FR-020 (lexical subset), FR-021, NFR-006, NFR-014, NFR-020.
Sources: docs/08_MEMORY_RAG_CLIENT_DNA.md §§1–6; docs/14_SECURITY_THREAT_MODEL.md;
ADR-033, ADR-064, ADR-070, ADR-071.

## Decision and reason

Retaining or reviewing a PDF for one request does not authorize indexing it.
Add an append-only admission ledger bound to the immutable retained receipt.
Only a current named Google office session with administrator membership, or
tenant and client `client_dna_manager` memberships, can approve or revoke it.
Approval requires review of the original and extraction limitations, both hashes,
an expected version, a stable action ID, and a reason. Original bytes must pass
verification before new approval. Revocation and reconciliation work without bytes.

A narrow database function locks current identity/membership, client and receipt,
checks the action fingerprint, and derives immutable search chunks directly from
the saved extraction in the same transaction as approval. Application roles get
read access only to the ledger and chunks. Existing generic knowledge tables are
mutable and have no named admission boundary; treating their metadata as approval
would be unsafe. These two small tables form an admitted PDF projection, not a
second general retrieval framework. No new dependency or external model is needed.

Search uses PostgreSQL exact substring, simple full-text and trigram matching over
normalized text, with original text separate. A materialized eligible relation
filters tenant, client, active client and latest positive admission before ranking.
Revoke appends a version; it excludes future search snapshots, without deleting
citations or source bytes. Reapproval is explicit. Receipt/version/page/chunk hashes
travel with results. Each query is bounded and labels vector/reranker as not run.
There is no cross-client search or browser-supplied corpus.

Desk connects search results to the saved PDF review and existing reviewed-request
handoff. Approval is permission to search reference material, not activation of
Client DNA, confirmation of every claim, model instructions, or final-copy approval.
Untrusted text stays text. It is not automatically injected into a model prompt.
The UI saves an unresolved action before sending it and retries identical bytes
and identity after reload; old action replay returns current state as well.

## Acceptance and remaining boundaries

Exercise real runtime PostgreSQL authority/RLS, preapproval exclusion, matching
English/Sorani/numerals, original strings and page citations, cross-client and
foreign-tenant exclusions, concurrent replay/conflicts, stale versions, missing or
damaged bytes, revoked identity, immutable writes, revoke/reapprove, and UI lost
responses/client switching. Keep API aliases, migration gates and traceability current.

Synthetic text fixtures prove behavior only. Real office relevance labels,
Recall@10/nDCG@10, latency at corpus scale, OCR/tables/images, vector/reranker
admission and automatic cited Design Plans remain unproved. No production changes.
