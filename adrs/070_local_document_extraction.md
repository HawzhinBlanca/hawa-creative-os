# ADR-070: Real local document extraction with explicit capability limits

Date: 2026-09-26
Status: accepted for implementation; production admission remains separate
Requirements: FR-011, FR-018, FR-019, NFR-006, NFR-014
Sources: `docs/08_MEMORY_RAG_CLIENT_DNA.md` §§3–7; `docs/14_SECURITY_THREAT_MODEL.md` §3; `MASTER_SPEC.md` §2.

## Finding

`DoclingParser` decoded every input as UTF-8, invented page numbers and boxes,
hashed the decoded text instead of the source bytes, and generated new chunk IDs
on every replay. It had no Docling runtime. Its passing test asserted the invented
coordinates. This cannot authorize PDF admission or supply reliable citations.

## Decision

- Replace that implementation with strict UTF-8 plain-text parsing and a pinned
  local Docling native PDF service. Plain text has byte hashes and character
  offsets, without invented pages. PDF text and boxes come from the actual parser.
  Stable chunk IDs include source identity, bytes, extractor version and position.
- Use Docling 2.130.0 native extraction with docling-parse 7.22.0. It needs no
  model weights, cloud provider, OCR, external plugins or remote source URLs.
  Lock transitive packages and isolate the parser from Core, secrets and outbound
  networking. Bound input, pages, text, response, CPU, memory, concurrency and time.
- Refuse malformed, oversized, partial and textless-page PDFs. No fallback to raw
  binary decoding or success with silently missing pages. Report native reading
  order, OCR, tables and image-extraction limitations explicitly. Text extraction
  does not prove layout fidelity or source completeness for graphic/scanned pages.
- Offer a client-authorized, read-only PDF inspection in Desk. It does not create
  tasks, index knowledge, approve copy, or activate Client DNA. Scope is checked
  in PostgreSQL before extraction and rechecked before returning the result.
  Source bytes are transient for inspection; the response says they were not saved.
- Keep request-owned PDF intake held until durable source retention, explicit
  human confirmation and task handoff have their own complete acceptance evidence.

## Evidence required

Red-before tests for fabricated provenance, unstable IDs and corrupt source
hashing; parser boundary tests; real multi-page compressed PDF conversion inside
the isolated service; malformed/scanned/limit failures; authorization and stale
client UI checks. No live production or multilingual PDF quality claim follows
from a local English fixture.

Upstream reference: [Docling native pipeline, pinned v2.130.0](https://github.com/docling-project/docling/blob/v2.130.0/docling/pipeline/native_pdf_pipeline.py), read 2026-09-26. This pipeline explicitly omits semantic reading order, headings, OCR and table reconstruction.
