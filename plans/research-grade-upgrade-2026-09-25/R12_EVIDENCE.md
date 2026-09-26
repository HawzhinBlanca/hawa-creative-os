# R12 — Retrieval truth and scope, first slice

## 2026-09-26 — Local PDF inspection with real provenance (ADR-070)

The unused `DoclingParser` still decoded binary documents as UTF-8, invented page
numbers/boxes and changed chunk IDs on every replay. Six red-before tests reproduced
those defects, including loss of the original byte hash when decoding a BOM. It
now strictly decodes plain UTF-8 with character offsets, or invokes a pinned local
Docling native PDF service. Original-byte hashes, parser version, measured pages
and boxes are independently checked; chunk identities are deterministic and
source-bound. Token counts are explicitly estimates. Unsupported MIME, invalid
UTF-8, mismatched hashes/versions, partial pages and excessive results are refused.

Desk's client Brand DNA view now offers **Inspect a PDF**. The authenticated
`POST /v1/clients/{clientId}/documents/inspect` checks active PostgreSQL/RLS access
before and after conversion. It streams a bounded upload, permits one active
inspection per Core process, and returns an explicitly unsaved/unapproved preview.
No source, task, knowledge item or DNA is written. Client changes discard late
responses; React displays document content as text, with page selection and
extraction limitations. This is a usable inspection slice, not automatic PDF
brief intake or governed document indexing. Requirements: FR-011, FR-018, FR-019,
NFR-006, NFR-014. Usage and deployment boundary: `services/docling/README.md`.

The sidecar pins Docling 2.130.0, docling-parse 7.22.0, all resolved Python packages
and the Python base-image digest. It takes bytes only, with no source paths/URLs,
models, OCR, external plugins or credentials. Limits cover bytes, pages, text,
response size, process count, upload/conversion deadlines, CPU and memory. Its
non-root, read-only container has a private internal network and no host port.
A direct connection probe returned `ENETUNREACH` for an external address.

**Real acceptance:** `R12_DOCLING_PROOF.json` preserves six passing checks through
the actual container and compiled TypeScript adapter: two compressed PDF pages
with exact text/measured coordinates and source hash, stable replay, blank-page
refusal, 41-page refusal, malformed-PDF refusal and an oversized HTTP body. Source
hashes, compiled adapter hash and tested parser/probe image IDs are recorded.

**Verification:** six red-before failures; final focused checks passed **5 files / 39 tests**. Full source/test typecheck,
lint, Desk build (441.06 kB main chunk) and zero-secret scan passed. The full
regression suite follows the source/evidence commit and candidate seal. Early integration runs exposed
stale workspace package output, a wrong fixture path and an unsupported test
principal tenant override; these were fixed rather than counted as passing. The
first Compose run failed because tmpfs commas needed quoting. The host could not
reach the internal Docker network, so the real probe was moved into that same
private network without giving the parser an egress route.

The first full run on source `3749845` / seal `edb83d5` passed **3,409 tests**
and failed one route-inventory test (56 skipped). Its only diff was the four
intentional prefixes of the new inspection endpoint; the inventory fixture had
not been updated. The follow-up adds exactly those four entries, retains the
failure here, and reruns the inventory and sealed release checks. Runtime and
real-container proof sources are unchanged.

Limits remain explicit: native text ordering is unverified; OCR, table structure
and images are not extracted. Textless pages are held, and visual information on
otherwise text-bearing pages can still be absent. English fixtures do not qualify
Sorani/Arabic PDF fidelity. No production service/configuration changed. R12 stays
in progress: approved source retention/indexing, hybrid retrieval evaluation and
human quality evidence remain open; lifecycle PDFs/voice still hold.

**Date:** 2026-09-25. **Status:** in progress. **Source:** `02fff0b` on `codex/research-grade-design-system`.

## What changed

The existing in-memory `RetrievalService` was a lexical fixture but attached invented `vectorScore` and `rerankScore` values to every match. Its `ingest` method parsed a fabricated sample string derived from a source ID, marked its chunks approved, and answered success without reading source bytes. Its `evaluate` method issued a random run ID without running an evaluation. Those claims could make an unmeasured path look like a hybrid index with evidence.

Retrieval now filters tenant, client and active state **before** normalized lexical scoring; unapproved positive records cannot enter evidence or authoritative assets/rules. Rejected examples stay in negative evidence. The context trace says `lexical_only` and `not_run` for vector/reranker stages, and those score fields are absent. An active Client DNA fixture is indexed with a version and content hash; unchanged snapshots are skipped, superseded versions become inactive, and rule IDs are deterministic for their source/version. A missing approved logo yields a blocking missing-asset conflict even when an unapproved logo record exists. The in-memory index remains a test baseline, not a database authorization boundary.

Metadata-only `ingest` now refuses with `RETRIEVAL_INGEST_NOT_IMPLEMENTED`; `evaluate` refuses with `RETRIEVAL_EVALUATION_NOT_IMPLEMENTED`. Their current request contracts do not provide approved source bytes or a sealed relevance dataset, so success would be invented. The old `retrieval_eval.jsonl` runner builds every candidate's text from that case's query and expected IDs. Its 100% pass rate is therefore a **synthetic contract check with label leakage**, marked `admissionEligible: false`; the CLI no longer announces that all role gates passed. The aggregate tournament also reports `admissionEligible: false`.

## Proof and limits

Negative tests cover a higher-scoring foreign-tenant record sharing the same client ID, a higher-scoring unapproved record, an unapproved logo, Sorani/Arabic search variants, missing vector/reranker scores, metadata-only ingestion, invented evaluation receipts, unchanged DNA reindex, and exclusion of superseded DNA rules. Existing client-knowledge and eval fixture tests still run. **Focused verification:** 4 files / 28 tests passed; TypeScript source and included tests passed. The first focused run after the retrieval edit passed 4 files / 27 tests; the final focused count includes the added negative control.

R12 is **not accepted**. No approved source-byte parser/index pipeline, PostgreSQL tenant/client filter, visual embeddings, reranker, sealed independent relevance labels, Recall@10/nDCG@10 comparison, or measured latency/cost benefit exists here. An active DNA object supplied by a caller is not proof of client-signed approval. The retrieval runner remains a synthetic fixture, and no production retrieval service or model was promoted.

**Fixed-tree verification:** Source `02fff0b`, evidence commit `850b6af` and source-candidate seal `258228f` passed **406 files / 3,052 tests** with **4 files / 48 tests skipped**. TypeScript checks passed, blueprint validation reported **731 pass / 0 warning / 0 failure**, and the clean-tree release manifest verified with both production flags off. The subsequent evidence-only update does not change the exercised source. No deployed image or authorized relevance corpus was tested.
