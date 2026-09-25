# R12 — Retrieval truth and scope, first slice

**Date:** 2026-09-25. **Status:** in progress. **Source:** `02fff0b` on `codex/research-grade-design-system`.

## What changed

The existing in-memory `RetrievalService` was a lexical fixture but attached invented `vectorScore` and `rerankScore` values to every match. Its `ingest` method parsed a fabricated sample string derived from a source ID, marked its chunks approved, and answered success without reading source bytes. Its `evaluate` method issued a random run ID without running an evaluation. Those claims could make an unmeasured path look like a hybrid index with evidence.

Retrieval now filters tenant, client and active state **before** normalized lexical scoring; unapproved positive records cannot enter evidence or authoritative assets/rules. Rejected examples stay in negative evidence. The context trace says `lexical_only` and `not_run` for vector/reranker stages, and those score fields are absent. An active Client DNA fixture is indexed with a version and content hash; unchanged snapshots are skipped, superseded versions become inactive, and rule IDs are deterministic for their source/version. A missing approved logo yields a blocking missing-asset conflict even when an unapproved logo record exists. The in-memory index remains a test baseline, not a database authorization boundary.

Metadata-only `ingest` now refuses with `RETRIEVAL_INGEST_NOT_IMPLEMENTED`; `evaluate` refuses with `RETRIEVAL_EVALUATION_NOT_IMPLEMENTED`. Their current request contracts do not provide approved source bytes or a sealed relevance dataset, so success would be invented. The old `retrieval_eval.jsonl` runner builds every candidate's text from that case's query and expected IDs. Its 100% pass rate is therefore a **synthetic contract check with label leakage**, marked `admissionEligible: false`; the CLI no longer announces that all role gates passed. The aggregate tournament also reports `admissionEligible: false`.

## Proof and limits

Negative tests cover a higher-scoring foreign-tenant record sharing the same client ID, a higher-scoring unapproved record, an unapproved logo, Sorani/Arabic search variants, missing vector/reranker scores, metadata-only ingestion, invented evaluation receipts, unchanged DNA reindex, and exclusion of superseded DNA rules. Existing client-knowledge and eval fixture tests still run. **Focused verification:** 4 files / 28 tests passed; TypeScript source and included tests passed. The first focused run after the retrieval edit passed 4 files / 27 tests; the final focused count includes the added negative control.

R12 is **not accepted**. No approved source-byte parser/index pipeline, PostgreSQL tenant/client filter, visual embeddings, reranker, sealed independent relevance labels, Recall@10/nDCG@10 comparison, or measured latency/cost benefit exists here. An active DNA object supplied by a caller is not proof of client-signed approval. The retrieval runner remains a synthetic fixture, and no production retrieval service or model was promoted.
