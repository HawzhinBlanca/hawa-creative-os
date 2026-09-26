# R12 — Retrieval truth and scope, first slice

## 2026-09-26 — Retained PDF to reviewed Desk request (ADR-071)

The next vertical slice retains original PDFs and their immutable extraction
receipts, then binds explicitly reviewed copy into the existing manual Desk task
transaction. The read-only preview remains available. Saving a document alone
creates no task, knowledge index, DNA version or approval.

- Migration **041** adds append-only client documents with source and extraction
  hashes, extractor version, authenticated creator, client RLS and a blob GC root.
  Original bytes use the existing file store. Receipt identity is unique per
  tenant/client/source hash/extractor version; replay reuses the first extraction.
  Both original downloads and task handoff verify actual stored bytes. A same-size
  corrupt file cannot be acknowledged as retained even if blob `put` finds it.
- `POST /clients/:clientId/documents` saves; GET list/receipt/content reopens evidence.
  The latest 20 receipts are available in Desk; any known receipt remains addressable.
  Read-only/foreign-client/foreign-tenant identities cannot write or cross scope.
  Source saving rechecks client access after parsing and under the receipt transaction.
- Explicit PDF confirmation extends `POST /tasks` using the existing task repository.
  Receipt ID, source/extraction hashes, active writable client and verified bytes
  are required. Server-authored provenance binds the real actor and reviewed copy.
  Task/event/outbox commit together; keyed concurrent retries produce one task.
  Changed payload conflicts; exact retries retain original evidence after a client
  becomes inactive or the parser is stopped. Blob metadata uses the same transaction
  connection, avoiding pool exhaustion from nested connection reservations.
- Desk requires human-selected copy and a confirmation checkbox. Edits reset
  confirmation. An uncertain response freezes the complete request/key in its own
  browser recovery slot and restores the saved source on reopening that client.
  Client switches discard stale responses. The task brief exposes the original PDF.
  The planner reads confirmed strings without legacy chat divider/remark/emoji
  cleanup; blank English remains blank for Sorani-only requests.

Requirements: **FR-001, FR-002, FR-004, FR-006, FR-011, FR-018, FR-019,
NFR-006, NFR-014**; linked normative documents in traceability and ADR-071.

### Executed verification

- Focused final run: **9 files / 103 tests passed**, no skips. PostgreSQL tests use
  the actual runtime RLS role and filesystem blob store. Extraction is mocked in
  these handoff tests; ADR-070's six real isolated Docling checks remain the separate
  parser proof. This turn did not rerun or claim new real-PDF quality admission.
- New Core coverage: retained byte/hash round trip, stable extraction reuse in new
  app instances without the parser, GC protection, receipt immutability, concurrent
  task replay, changed-payload conflict, unconfirmed/wrong-hash/cross-client refusal,
  corrupt bytes, missing store/database, revoked access, read-only identity,
  foreign tenant, transaction fault rollback and exact Sorani-only planner input.
- New Desk coverage: empty initial copy, explicit confirmation and reset on edit,
  exact user-selected strings, independent recovery slot, unchanged key/body retry
  after remount, saved-source browsing and recovery without automatic submission.
- Migration replay and real Core entrypoint schema refusal: **2 files / 11 tests passed**.
  Explicit migration inventories now include 041. Blueprint validation: **839 pass / 0 warn / 0 fail**.
- Full source/test typecheck, lint, Desk production build and secret scan passed.
  Lint remains 1,006 `any` uses against ceiling 1,053 and 9 pre-existing provider
  egress exceptions. Exact full-suite and manifest results follow source sealing.
- One initial typecheck reached the sandbox IPC restriction (`EPERM`) before test
  types ran. It was rerun with permitted IPC access and passed. No failed application
  assertion is hidden; the rollback test deliberately injects/logs a commit-boundary
  failure and verifies absence of the task/outbox before successful replay.

### Scope and remaining work

This is Desk document-to-request admission, with a human-reviewed copy boundary.
It does not admit Telegram PDF/voice, OCR, image/table extraction, approved knowledge
indexing, production parser activation, a real process-kill/restore drill for this
new document receipt, live Canva/Google export/reopen, native Sorani PDF fidelity or
independent creative quality. Restart evidence uses new Core app instances and
unchanged PostgreSQL/file storage. Source receipts follow existing append-only audit
retention; no expiry/purge UI is added. Pending browser identity survives reload,
but clearing browser storage requires checking Work before creating another task.
No production service, flag or configuration changed. R12 remains **in progress**.


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
