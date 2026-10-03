# ADR279 — Preserve admitted web photos at the internal HTTP boundary

Date: 2026-10-03. Status: repair implementation; native rerun pending.
Requirements: FR-006/018/068/069, NFR-006/024/025.
Sources: ADR261; docs/09_MESSAGING_AND_OFFICE_INBOX.md;
docs/08_MEMORY_RAG_CLIENT_DNA.md; docs/14_SECURITY_THREAT_MODEL.md.

The actual six-photo browser/worker rehearsal passed all thirteen browser controls,
but the worker's first projection failed HTTP409 IDEMPOTENCY_CONFLICT. The internal
openDraft parser selected known fields and silently omitted customerWebPhotos.
Core then correctly refused the altered draft against its retained canonical
brief. Direct projectLifecycleOpen tests bypassed this HTTP parser and missed it.

Preserve the bounded typed manifest only for hawzhin_web drafts. Validate its
version, one-to-twenty unique JPEG/PNG/WebP references, ten-MiB per-photo limit,
exact object keys and exclusive source type. Do not accept web manifests on
Telegram drafts or alongside album/image/document sources. Core still reconstructs
ownership and the manifest from immutable receipts and compares the entire brief:
worker-provided hashes are never authority.

Add an actual mounted HTTP regression covering six originals, exact ordered
manifest, one task and replay. Changed, omitted or reordered manifests must still
fail; malformed manifests must fail before projection. Rerun the native shared
login/browser/restricted worker/Restate fixture. Keep the original failed report.
This repair does not enable public generation or qualify provider/Canva quality.

The next native run passed manifest admission but refused originals as
UNVERIFIED_DESIGN. A one-connection mounted HTTP regression reproduces this:
projection holds its transaction while a hash-only BlobStore read borrows another
connection for metadata. Pass the complete already authorized immutable reference
to BlobStore.read instead. Size and hash checks remain required, and owner/client
receipt validation still occurs inside the projection transaction. This avoids
six redundant metadata queries and dependence on a spare pool connection. Keep
the original native failure and the one-connection red assertion; rerun both.
