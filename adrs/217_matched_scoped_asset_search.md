# ADR217 — Match scoped assets before the search bound

Date: 2026-10-01. Status: connected and seven-stage engineering verified; production-dump/native/human/product admission pending.
Requirements: FR-077, FR-011, NFR-012.
Sources: docs/17_UI_UX.md, docs/08_MEMORY_RAG_CLIENT_DNA.md,
docs/09_MESSAGING_AND_OFFICE_INBOX.md, MASTER_SPEC.md.

## Evidence and reason

Asset search uses the upload inventory's newest-500 listing before matching
query words. An older relevant upload can therefore disappear behind unrelated
newer uploads, without a truncation warning. Search also invents a 1024-byte size
for stored assets whose size was never recorded.

## Decision

Keep PostgreSQL/RLS authority and the existing lexical engine. Search active
assets with tenant/client scope and the shared normalized OR-token predicate
before a bounded database read. Search only registered name, media type, kind and
content hash; arbitrary metadata and storage locations are not query text.
Read at most 5,000 matching assets by default, with a positive finite override
clamped to 1–20,000. One extra row detects truncation; order by creation time and
ID so equal timestamps are deterministic. Keep the separate upload inventory's
existing newest-500 behavior. Unknown size is explicitly unavailable, not a
fabricated number. No model, embedding, schema, dependency or provider change.

Asset ID is also an exact searchable identity. Categories that do not consume
assets do not read their inventory; a failure of a required asset read still
refuses the response without returning a previous warmed result.

## Qualification

Retain actual Core/PostgreSQL failures on the published baseline. Verify old
name/hash/kind/media matches, Sorani normalization, bounded matching and visible
truncation, deterministic order, unknown size, inactive/foreign-client/foreign-
tenant exclusion, authorized broad and assigned-designer reads, aliases and
unknown clients, allowed-field-only indexing, and unavailable reads after a
warmed result. Run connected search/asset/isolation controls, strict compilation,
build/lint and the exact release gate. Full generation-attempt, native/human and
product admission remain separate; production-dump authorization is still pending.

## Connected evidence

ADR217 CONNECTED: actual newest-500 asset-search omission and invented1024B closed with query-before-bound active SQL/RLS, typed fields/ID/Sorani matching, stable timestamp/ID order and explicit missing size. Cold/broad/alias/assigned-designer/foreign-tenant/inactive/read-failure controls plus actual20005 matching-row hard20000/truncation pass; separate inventory500 preserved. Original7fail/1pass retained;9 new tests,6files55pass/0fail/0skip,697 roots/build/lint. FR011 read boundary only. Exact gate/native/human/product pending; no deploy/model/embedding/schema/dependency. W6_SCOPED_ASSET_SEARCH_PROOF.json.

Exact clean seal ad0b2cb1 passes seven engineering stages: 6900 passed / 0 failed / 67 skipped across 690 passed files / 6 skipped; 697 strict roots and 1780 package checks. Mandatory negative-flag refusal passes. Raw production-dump Stage 3 remains skipped: previous automatic approval review requires explicit transfer authorization, still pending. No all-eight qualification, deployment or native/human/product admission claim. W6_SCOPED_ASSET_SEARCH_GATE_EVIDENCE.json retains actual receipts.
