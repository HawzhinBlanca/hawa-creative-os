# R12 — Retrieval truth and scope, first slice

## 2026-09-26 — Real PDF process-crash and restore proof

The retained-PDF journey now has an opt-in acceptance drill using actual Core HTTP
processes, named database sessions, the runtime RLS role, pinned offline Docling
extraction of a compressed two-page PDF, and real PostgreSQL/filesystem storage.
Existing chaos instrumentation adds four observation points; without the chaos
control environment they are no-ops. No persistence foundation or production flag changes.

Four actual **SIGKILLs** interrupt responses after original bytes, the immutable
receipt, the knowledge decision, and the task/event/outbox commit. Six Core starts
reconcile the same source, decision and request identities. The drill checks no
invented receipt, one committed receipt, atomic approved chunks, one task/event/outbox,
changed-payload conflicts, GC protection, exact English/Sorani request strings,
original page boxes, current revocation on old approval replay, and parser-free reopening.

It then quiesces Core, takes a PostgreSQL custom-format dump and a blob-file copy,
restores into a fresh database and different directory, and deletes only its original
disposable database/store. New Core reads must use the restore. Byte-identical PDF,
all named approval versions, complete search/citations, source/copy evidence and
request identity survive. Same-size corruption subsequently refuses original download
and new task creation, while revocation and old-action reconciliation still work.

**Actual defect corrected:** native parser coordinates are an object
`{x, y, width, height}`. The search OpenAPI schema and mocked Core fixture had an
array shape. Both now match real output; Desk's citation type includes the object.
The drill checks both actual pages by chunk identity rather than assuming result order.

**Acceptance:** **8 files / 76 tests passed**, including the opt-in drill with **31
invariants**, four process kills and six starts. Source/included-test typecheck, lint
(1006 existing `any`, 9 existing provider-egress exceptions), Desk build and a
zero-secret scan passed. Full regression and candidate sealing follow the source commit.
See `R12_DOCUMENT_RECOVERY_PROOF.json` for actual hashes and
`services/docling/README.md` for the guarded reproduction command.

**Failed harness runs retained:** the first run failed because Vitest does not expose
`import.meta.resolve`; use Node `createRequire` instead. Two subsequent starts were
correctly refused because the minimal production-mode environment lacked an action
HMAC secret; the harness now generates a disposable synthetic value. These were
harness setup failures, not reproduced application recovery defects. The first full
drill then passed; final focused verification includes stronger checks of both pages.

**Limits:** only `hawa_t_*` local test databases on port 55432 and temporary blob
stores are admitted. Each child has a fresh cwd, synthetic environment and a fetch
guard; office `.env.local` is never loaded. Real offline parser JSON is replayed over
a loopback bridge. Normal regression skips this explicitly gated test. A quiesced
same-host fixture restore does not prove WAL/PITR, off-site or clean-host recovery,
production RPO/RTO, Restate execution or live Workspace/provider reconciliation.
R12 remains in progress. Telegram PDF/voice, real multilingual PDF fidelity, retrieval
relevance/scale, automatic cited Design Plans and independent human quality remain open.

## 2026-09-26 — Approved PDF reference search (ADR-072)

Retained PDFs now have a separate, explicit reference-search approval. A live named
Google office administrator, or a tenant-and-client DNA manager, can approve or
revoke the exact source/extraction receipt with a reason, expected version and
stable action UUID. Retention and request-copy confirmation grant no knowledge
approval. Approval author identity and display name come from locked server records.

Migration **042** adds immutable admission events and immutable derived PDF chunks.
Runtime roles can read scoped rows but cannot insert/update/delete these projections.
A narrow database function checks and locks session, user, memberships, client and
receipt, fingerprints the decision and derives every chunk from the saved extraction.
One malformed chunk rolls back both index and approval. Original PDF bytes are
hash-verified before new approval; revocation and action reconciliation work even
when the original is missing. Replaying an old approval after revocation returns
that original action plus the current revoked state, without resurrecting it.

Search filters tenant, client, active client and the latest positive admission in
a materialized PostgreSQL relation before lexical ranking. It combines normalized
exact substring, simple full-text and trigram matching, preserving original strings
and immutable source/extraction/chunk hashes, page coordinates, extractor version,
approval version and action ID. Query/output/time limits are explicit. Results are
labeled `postgres_lexical_v1`; vector and reranker are `not_run`. The immutable PDF
projection is separate from the older mutable generic knowledge tables because
metadata on those tables does not prove named approval.

Desk exposes approval/revocation and the latest 20 named audit events. Uncertain
actions are retained before sending and replay identical bytes/key after reload.
Search results are rendered as text and open the saved PDF at the cited page, where
the existing reviewed-request form still starts with empty copy. Client changes and
local approval changes discard stale results. Document text never becomes model
instructions, Client DNA or final copy automatically. Search is a query snapshot;
revocation affects future queries, not copies a reader already viewed.

**Acceptance:** real isolated PostgreSQL/runtime RLS and jsdom checks passed
**9 files / 71 tests**. New coverage comprises **8 Core / 6 Desk tests**. It checks
named authority and revocation, source integrity, atomic rollback, competing/replayed
and changed actions, client/foreign-tenant and unapproved-source exclusion, bounded
queries, English/Sorani/numeral variants, exact original citations, immutable writes,
missing-source revocation, client switching, lost-response recovery, storage failure
and search-to-source-to-reviewed-request handoff. Parser output in this slice is
mocked native extraction; ADR-070 retains the separate real-container parser proof.
These fixtures do not establish real office PDF fidelity or retrieval relevance.

**Checks:** source and included-test typecheck, lint (1006 existing `any`, unchanged;
9 existing provider-egress exceptions), Desk build and zero-secret scan passed.
**Sealed regression:** source `dbf1646`, seal `7694ef9` passed **442 files / 3440 tests**, with **4 files / 56 tests skipped**. Blueprint **843/0/0** and clean-tree release manifest verified; production flags remain off. This evidence-only recording changes no implementation.

**Failed runs retained:** five initial red-before acceptance failures were missing
routes. The first DB run passed 8/failed 1 because a removed client membership is
concealed by RLS as 404, rather than the test's expected 403. The first nine-file
run passed 66/failed 2: revoked-session middleware correctly returned 401 rather than
403, and a test helper returned undefined for an absent button rather than null.
Assertions were corrected to preserve those boundaries. Initial typecheck found two
untyped route contexts; both now use Hono Context, with no added `any`. Final
71-test verification passed. Earlier passing subsets are not added to this total.

**Limits:** R12 remains in progress. This completes approved retained-PDF reference
search, not automatic cited Design Plans, visual/vector/reranker evaluation, large
corpus latency admission, folder-wide Drive ingestion, OCR/tables/images, real
multilingual PDF qualification or a new process-kill/restore drill. Telegram PDF/voice,
live Workspace/provider/export/reopen/restore and independent human-quality gates
remain open. No production service, flag, model or integration was activated.

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
  egress exceptions. Source `96f1f5e`, seal `a28e9d3`: **440 files / 3,426 tests passed;
  4 files / 56 tests skipped**, clean-tree release manifest verified and blueprint
  **839/0/0**. The following evidence commit changes documentation/pack hashes only.
- One initial typecheck reached the sandbox IPC restriction (`EPERM`) before test
  types ran. It was rerun with permitted IPC access and passed. No failed application
  assertion is hidden; the rollback test deliberately injects/logs a commit-boundary
  failure and verifies absence of the task/outbox before successful replay.

### Full-suite correction before admission

The first sealed run on source `6e66c50` / seal `932a330` passed **439 files /
3,423 tests**, skipped **4 files / 56 tests**, and failed one existing architecture
check: `client_documents_write` evaluated a membership helper per row. The unreleased
041 policy now uses ADR-033's statement-level role/membership sets with the same
client permissions. No deployed database was modified. A client-only designer
probe then exposed the existing operator-only outbox boundary (25 passed/1 failed):
source retention succeeded but task creation returned an opaque 503. Confirmation
now checks that permission explicitly and returns 403; an operator can confirm the
retained source. Outbox permissions were not widened. Added designer retention,
operator handoff and cross-client refusal; the policy, document intake, migration replay
and real Core startup group passed **4 files / 26 tests**. Including the operator
refusal UI and manual-intake recovery, the final correction group passed **6 files /
37 tests**. The final source is resealed
and the full suite rerun; results below replace no failed-run history.

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
