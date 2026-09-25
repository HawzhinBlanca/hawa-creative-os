# ADR-044: Reserve a Drive file ID before publication upload

**Date:** 2026-09-25
**Status:** Accepted for implementation on `codex/research-grade-design-system`; no production cutover.
**Amends:** ADR-043's Drive retry boundary.
**Requirements:** FR-047, FR-048, FR-050; R09.

## Context

The publisher checks all Drive search pages before uploading, but a read cannot serialize two Core processes. Both can observe no file and create separate copies. Drive search may also lag after an upload whose response was lost.

Google Drive supports a pre-generated file ID for a binary upload. A retry with the same ID returns HTTP 409 if the first create succeeded, without another file. The ID must be durable before the first upload; generating a new ID on replay would defeat this property. See Google's [upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads) and [generateIds reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds), checked 2026-09-25.

## Decision

Core reserves one generated Drive ID in PostgreSQL per publication and artifact, bound to the tenant, task, package hash, folder, filename, MIME type and content SHA-256. Generate the ID outside a database transaction, then insert it with a unique key; a concurrent loser reads and uses the winning row. No upload starts until that row commits. The publisher includes the reserved ID in `files.create`. A 409 or uncertain response is reconciled by reading back that exact ID and validating the stored metadata and checksum. Any mismatch or unavailable readback stops the publication.

The existing paged Drive search remains a preflight for old uploads and divergent files. The Core app supplies the PostgreSQL reservation store to its default Google publisher. Direct publishers without that store retain the earlier lookup path and are not qualified for cross-process idempotency; these callers must be migrated or fenced before a universal claim. Reservation rows are insert-only and tenant-scoped. No provider call occurs inside a database transaction.

## Limits

This design must be tested under concurrent Core processes, a lost upload response, and a repeated 409. It still needs a real Google Shared Drive readback drill, operator resolution for conflicting old files, and full publication/Sheet/requester admission. It does not by itself prove that Google search is immediately complete or that all legacy files were created with reserved IDs.
