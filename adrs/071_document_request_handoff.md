# ADR-071: Retained PDF evidence and explicit Desk request handoff

Date: 2026-09-26
Status: accepted for implementation; production admission remains separate
Requirements: FR-001, FR-002, FR-004, FR-006, FR-011, FR-018, FR-019, NFR-006, NFR-014
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md §§2–3, 6; docs/08_MEMORY_RAG_CLIENT_DNA.md §§3–7; MASTER_SPEC.md §2; ADR-035, ADR-066, ADR-070.

## Decision and reasoning

Keep the read-only inspection API. Add an explicit save-and-inspect action that
retains original PDF bytes in the existing content-addressed store and an immutable,
client-scoped extraction receipt in PostgreSQL. A unique client/source hash/extractor
version identity reuses the first receipt, including after restart. Originals become
GC roots even before a request exists. Failure to retain bytes must refuse success.
No new storage provider, workflow or model call is needed.

The existing atomic manual task intake accepts a source receipt ID, original hash,
extraction hash and explicit confirmation. Under the task transaction it checks
client authorization and the exact receipt, verifies retained bytes, and records
server-authored provenance and the authenticated actor alongside the human-edited
copy. Stable request keys serialize concurrent duplicates. Changed copy with the
same key conflicts. Exact replay returns the original receipt without reparsing or
recreating task/event/outbox, even after parser or client configuration changes.

Task confirmation requires the existing outbox operator/administrator permission.
Client-level designers may retain sources for that review; a direct task attempt
gets an explicit 403 rather than an opaque outbox storage failure. No outbox
permission is widened.

The UI leaves copy empty until a human selects or types it; extracted text never
becomes executable instructions, approved Client DNA, indexed knowledge or a
publication approval. Review is about the chosen request copy only. Original PDF,
extractor limitations and extraction remain separately accessible. Shared Desk
identities retain their existing identity limitation; this is no named art-director
approval. Telegram PDF admission and OCR remain held.

## Evidence required

PostgreSQL integration: source hash/bytes and receipt replay across app instances;
client isolation/read-only refusal; missing/corrupt bytes; confirmation/hash conflicts;
concurrent task replay and changed-payload conflict; task/event/outbox atomicity;
GC retention; original download after restart. Desk: explicit confirmation, exact
edited copy, uncertain-response recovery, client changes, safe untrusted rendering.
Source/test typecheck, lint, focused and sealed full tests, route inventory, pack,
release manifest and traceability evidence are required before this slice is done.
