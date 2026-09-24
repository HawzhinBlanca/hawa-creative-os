# ADR-035: Pictures and Design Sources Live in a Content-Addressed File Store

**Date:** 2026-09-24
**Status:** Accepted 2026-09-24 by the owner ("yes, do all"); implementation in progress (architecture programme, Phase 3.1).
**Amends:** the storage of reference photos (`studioOptions.referenceImageBase64`), studio candidate PNGs, Canva plan sources, cut-out PNGs and comparison images. Canva export bytes (`canva_export_bytes`) are unchanged.

## 1. Context

- A Telegram photo becomes a base64 data URI and is written three times in Postgres (`task_events.data->'payload'`, `task_events.data` again, `outbox_commands.payload`), plus the Restate journal and, on the planner lane, `canva_design_plans.request`. A bilingual request doubles it.
- Queries that route replies, cap drafts and remind requesters scan these JSON payloads; `GET /tasks/:id` returns the newest export as a data URI; the outbox claim returns whole payloads.
- rsvg refuses any XML attribute over 10,000,000 bytes: on 2026-09-23 a rotated 12 MP photo, redrawn as a PNG data URI, failed every render of its design.
- In the test database, 265 MB of 334 MB is PPTX sources (about 1.5 MB each) in `canva_design_plans.source_content`.

## 2. Decision

1. Files at `~/.hawa/blobs/sha256/<first two hex>/<hex>.<ext>`, a bind mount (host backups see it). Writes go to `tmp/` on the same filesystem, are fsynced, renamed into place (an existing target means the same bytes: the temp file is discarded), the directory fsynced, mode 0444.
2. A table `hawa.blobs(sha256 PRIMARY KEY, size, media_type, created_at)`; every referencing table holds the hash with a foreign key `ON DELETE RESTRICT`. The tenant is on the referencing row.
3. Garbage collection is mark-and-sweep with a 14-day grace period: delete unreferenced `blobs` rows older than the grace period (the foreign key refuses referenced ones), unlink the file after the commit, sweep orphan files older than the grace period. No reference counts.
4. Serving: Core authorises on the referencing row, never on the hash, and answers with `X-Accel-Redirect` to an `internal` nginx location with `Cache-Control: private, max-age=31536000, immutable`.
5. The renderer reads pictures as files beside the SVG (librsvg reads files in the SVG's own folder; the upright step already does this), so no picture is inlined as a data URI.
6. Backups: the Postgres dump first, then the blob directory, into the existing encrypted archive; blobs never change and the grace period exceeds the backup interval, so every reference in a dump has its file. The restore drill restores both.
7. Order of moves: reference photos (the payload carries `{sha256, media_type}`, written once), plan sources, candidate PNGs, cut-outs, comparison images.

## 3. Consequences

- `task.created` payloads fall from hundreds of KB to under 4 KB; JSON scans stop reading images; the 10 MB render limit no longer applies to pictures.
- One more thing to back up and restore; covered by the drill.
- Canva export bytes stay in `bytea` (append-only, hash checked by the database, row-level security applies); revisited once the rest has moved.

## 4. Alternatives considered

- **Keep `bytea` everywhere.** Workable at this size, but it does not fix the data URI path through the renderer or the triple writes in JSON.
- **Postgres large objects.** A separate API and orphan cleanup (`vacuumlo`) for no gain.
- **An S3-compatible server.** MinIO's community edition repository is archived and ships no binaries; Garage single-node is an option only if the S3 API is ever needed. On one Mac it is another service, credential and backup for no measured need.
