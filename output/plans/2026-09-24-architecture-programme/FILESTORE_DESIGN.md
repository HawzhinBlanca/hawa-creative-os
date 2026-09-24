# Content-addressed file store (ADR-035, Phase 3.1): implementation design

Grounded in `studio-v2` at `79b70e0`. I changed nothing. To measure sizes I ran read-only aggregate SELECTs (`pg_total_relation_size`, `octet_length` sums) against `hawa_repair` on `hawa-test-postgres` and against production `hawa`. All numbers below were measured on 2026-09-24.

## 0. Findings the lead should see first

1. **Editable sources are missing from the plan.** `canva_editable_sources.content` (PPTX) is 117 MB in production. All 72 of its hashes equal a `canva_design_plans.source_sha256`, so it is a full duplicate of the plan sources. The ADR keeps only `canva_export_bytes` in bytea. I put editable sources in step 2 with the plan sources. Once they point at the same blob, they cost nothing extra.
2. **The "≤ 4 KB task.created" target fails on text alone.** 35 of the 1,598 production `task.created` payloads are over 4 KB with no picture at all. The largest is 6,097 B, made up of the legacy `body` field (up to 2.8 KB) plus the copy stored three times (`rawRequestText`, `designInstructions`, `exactCopy`). I propose this acceptance instead: no inline bytes ever, and ≤ 4 KB whenever the request's own text fields total ≤ 2 KB. The owner or lead should confirm.
3. **GC by age alone is unsafe.** The ADR deletes unreferenced rows by `created_at`. A 30-day-old preview that stopped being referenced yesterday would be deleted tonight, while yesterday's dump still references it. I add `unreferenced_since` and grace-period it instead. This is a one-sentence amendment to ADR-035 §2.3.
4. **Backups must be live before any bytes leave Postgres.** Until the "strip" step, the database still holds every byte, so losing blobs loses nothing. After it, it would.
5. **Migration number.** The highest today is `018_desk_list_indexes.sql`, and no worktree has an uncommitted migration (I checked all eight). So the first one is **019**, then 020 and 021. The Phase 0.2 evidence already mentions a possible "migration 021" (a per-claim uuid), and Phase 1.2 may add one. `discoverMigrations()` (`packages/db/src/upgrade.ts:8-21`) refuses gaps, so renumber at merge and update the expected list in `packages/db/test/schema-upgrade.test.ts:18`.
6. **Serving can't run before the new code is live.** `deploy.sh:233-235` applies migrations before it swaps containers. Foreign keys on columns the old Core already writes (`preview_sha256`, `art_sha256`, `source_sha256`, `sha256`, `hawa_sha256`, `designer_sha256`) would break the old Core's inserts during that window. So those foreign keys wait for migration 020, one release later.

---

## 1. Inventory: where bytes live today

Sizes are production unless marked "test" (`hawa_repair`: 348 MB total).

| # | What | Table/column or payload field | Typical size | Writers (file:line) | Readers (file:line) | Plan step |
|---|---|---|---|---|---|---|
| 1 | Telegram photo download | in memory, becomes a data URI | Telegram JPEG about 85 KB (113 KB as base64). An image sent as a file can be up to 20 MB | `apps/core/src/app.ts:4486-4495` (`downloadFile`, `sniffImageMime`, then `data:${mime};base64`). Simulator path `app.ts:4506-4507`. Bridge: `packages/integrations/src/telegram-bridge.ts:396` | Handed to intake at every site below | 1 |
| 2 | Reference photo in the intake payload | `studioOptions.referenceImageBase64` | same | `app.ts:2380-2386` (persist), `3986` (answer), `4636`, `4680`, `4722` (album parts), `5301` (orphan photo), `5681` (revision), `5807`/`5836`/`5855` (bilingual requests write it **twice**, once per language). In memory: `pendingClarifications` `app.ts:538, 5195, 5234`. Type: `apps/core/src/services/chat-intake.ts:36`, payload built at `236-249` | see 3 and 4 | 1 |
| 3 | `task.created` event, **twice per row** | `task_events.data.payload.studioOptions.referenceImageBase64` **and** `data.studioOptions.referenceImageBase64` | 25 events carry a photo (only 6 distinct photos), 5.8 MB of the 7.4 MB of `task.created` data. Largest row 319 KB. Table 8.1 MB | `packages/db/src/repositories/task.repository.ts:538-557` (`payload:` plus the `...payload` spread) | `design-studio-service.ts:184-275` (`requestImages`: 3 JSON scans), `339-345` (`getTaskContext` loads the whole `source`), `canva-design-planner.ts:160,184`, `app.ts:6571-6627` (`GET /tasks/:id` loads events), `app.ts:6758-6782` (timeline returns raw `data`) | 1 |
| 4 | Outbox `task.created` / `task.dispatch` | `outbox_commands.payload.studioOptions.referenceImageBase64` | 25 rows with an image. Without it, largest 6,097 B, median 662 B | `task.repository.ts:562-580`. Redrive copies the payload: `app.ts:2644-2660` | Claims strip it (`outbox.repository.ts:53-58, 123-127`). Payload is read by `chat-intake.ts:146-151, 184-189`, `app.ts:5104-5116`, and the daily cap `chat-intake.ts:222-226` | 1 |
| 5 | Restate payloads | ingress body `studioOptions` (`TaskWorkflow/<id>/run/send`); `ctx.run` journal of `studioBody` sent to Core `/canva/studio` | Before 0.2: up to about 160 KB per photo (a 20 MB file would be about 27 MB). Since 0.2: stripped | `apps/worker/src/workflow-dispatcher.ts:94,152`; `canva-draft-workflow.ts:373-386` | Core `/canva/studio`. `design_studio_runs.request` holds no image (0 rows) | 1 (nothing to backfill) |
| 6 | Legacy planner request | `canva_design_plans.request.referenceImageBase64` | 1 production row (50.7 KB); 16 in test | `canva-design-planner.ts:160,184,252` | Model call `canva-design-planner.ts:336-361`. The immutability trigger forbids changing `request` (007/010) | 1 |
| 7 | Plan sources (PPTX), **the bulk** | `canva_design_plans.source_content bytea` (plus `source_sha256`) | 82 sources, 120.5 MB, average 1.47 MB, largest 2.67 MB. **Test: 203 rows, 292 MB, only 122 distinct** | `canva-design-planner.ts:562`; `design-studio-service.ts:1997-2003` | `canva-design-planner.ts:588` (import); `design-studio-service.ts:1928-1936` | 2 |
| 8 | Editable sources (PPTX) | `canva_editable_sources.content bytea` | 72 rows, 112.5 MB, average 1.56 MB, **100% duplicate of 7** | `canva-connect-service.ts:329` | `canva-connect-service.ts:332` (`createImportJob(source.bytes)` from memory); manifest read at `488` | 2 (added by this design) |
| 9 | Candidate PNGs | `design_studio_candidates.preview_png`, `composite_png`, `art_png` | 100 previews 17.7 MB (average 177 KB); 100 composites 6.6 MB; 64 art 7.2 MB. Table 32.9 MB | `packages/db/src/repositories/design-studio.repository.ts:228-231, 304-307`, called from `design-studio-service.ts:1380-1384, 1488, 1532-1534, 1703-1705, 1726-1728` | `design-studio-service.ts:731-747, 1524, 1563, 1662, 1698, 1759, 1871, 1955-1957, 2532-2577`; `app.ts:8078-8090` (runner-ups sent to Telegram); `routes/design-studio.routes.ts:206-251` (serves by loading **every** candidate of the run) | 3 |
| 10 | Cut-outs | `photo_cutouts.png`, `shadow_png` | 2 rows, average 497 KB (test: 40 rows, 2.3 KB fixtures) | `design-studio/photo-cutouts.ts:268-282`. Service returns base64 JSON: `services/cutout/hawa_cutout/server.py:108,112` | `photo-cutouts.ts:225-230`, then `options.photoCutouts` into the renderer | 4 |
| 11 | Comparison images | `comparison_pairs.hawa_png`, `designer_png` | 0 in production (test: 88). Up to 15 MB each (CHECK in 015) | `services/comparison-study.ts:694-695` | Office `comparison-study.ts:715-719` via `routes/comparison.routes.ts:137-147`; judge `comparison-study.ts:961-966` via `comparison.routes.ts:206-222` | 5 |
| 12 | `GET /tasks/:id` preview | `canva_export_bytes.content`, returned as `encode(...,'base64')` inside a PNG data URI | PNG exports average 141 KB | (export writer `canva-connect-service.ts:537`) | `app.ts:6587-6592, 6640`, then Desk `WorkScreen.tsx:1105` and `components/VectorInspector.tsx:30` | serving change |
| 13 | Renderer data URIs | photos, cut-outs, art, logo inlined into SVG | photos up to 7 MB by design (`PHOTO_DATA_URL_MAX`); logo 1.5 MB before prescale | `packages/creative/src/studio/render-layout-v2.ts:1408` (cut-out), `1603-1606` (art), `1689-1709` (photos), `1720-1731` plus `1525/1551` (logo); `photo-treatments.ts:291, 318, 341`; `transfer-v2.ts:528` then `91`; `photo-upright.ts:66` | rsvg subprocess `render-layout-v2.ts:1776-1812, 1846-1882` | 6 |
| 14 | Canva export bytes (**stay**) | `canva_export_bytes.content` | 35.5 MB: 46 pptx (24.6 MB), 67 png (9.4 MB), 1 pdf | `canva-connect-service.ts:537` | `app.ts:2728, 5107, 5165, 6589, 8062`; `canva-design-planner.ts:241`; `comparison-study.ts:659`; `canva-task-outcome.ts:209,277,417`; `canva-connect-service.ts:291,543,549,566,586,598`; `design-studio-service.ts:2537,2554`; `apps/worker/src/delivery-notification.ts:52` | unchanged |
| 15 | Transient, out of scope | voice (`app.ts:4427-4442`), guideline PDFs (`telegram-rules-intake.ts:246`), model-call data URIs, pptxgenjs `addImage({data})` (`transfer-v2.ts:389,482,510,538,620`, `editable-transfer.ts:68,99`) | | | | none: never stored, and PPTX building is not SVG |
| 16 | Legacy `inbox_events.payload` | a simulator's `referenceImageBase64` in `rawJson` | 0 in production, 8 in test | `chat-intake.ts:258-261` | none | left alone: `payload_hash` depends on it |

Two follow-ups outside 3.1. First, `app.ts:5107` base64-encodes the export of all five candidate tasks in the SQL to use one. Second, `apps/desk/public/sw.js:115-135` caches every `GET /v1/*` response unbounded. That cache must skip binary routes (section 3).

---

## 2. The store module

### 2.1 Placement and types
- **`packages/contracts/src/blobs.ts`**, exported from `index.ts`. It holds the shared, dependency-free parts used by Core, the worker and creative:
```ts
export const BLOB_MEDIA_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
} as const;
export type BlobMediaType = keyof typeof BLOB_MEDIA_TYPES;
export interface BlobRef { sha256: string; mediaType: BlobMediaType; size: number }   // about 110 B as JSON
export const blobRefSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), mediaType: z.enum([...]), size: z.number().int().positive() });
export function blobRelPath(ref: Pick<BlobRef,'sha256'|'mediaType'>): string  // `sha256/${h.slice(0,2)}/${h}.${ext}`
```
- **`packages/db/src/blobs/store.ts`**, exported from `packages/db/src/index.ts`. It needs Kysely.
```ts
export interface BlobStat extends BlobRef { createdAt: Date; unreferencedSince: Date | null; path: string; onDisk: boolean }
export class BlobStore {
  constructor(opts: { root: string; db: Kysely<Database>; fsync?: boolean /* test-only off */; fs?: BlobFs /* fault injection */ });
  put(bytes: Uint8Array, mediaType: BlobMediaType, opts?: { trx?: Kysely<Database> }): Promise<BlobRef>;
  read(ref: BlobRef | string, opts?: { verify?: boolean }): Promise<Buffer>;   // checks size always; sha256 when verify
  open(ref: BlobRef): Promise<fs.ReadStream>;                                    // Core stream mode
  stat(sha256: string): Promise<BlobStat | null>;
  pathOf(ref: BlobRef): string;                                                  // absolute path in this container
  accelUri(ref: BlobRef, prefix = '/_blobs/'): string;                           // '/_blobs/sha256/ab/<hex>.<ext>'
}
export function blobStoreFromEnv(db): BlobStore   // HAWA_BLOB_DIR required. Throws if missing in production or test.
export class BlobMissingError, BlobCorruptError, BlobMediaTypeError
```
- `packages/db/src/blobs/gc.ts` (mark, sweep, unlink, orphan and tmp sweep) and `packages/db/src/blobs/verify.ts` (fsck). The CLIs live in `apps/core/src/tools/blob-gc.ts` and `blob-verify.ts`, beside `rotate-canva-token-key.ts`.

### 2.2 On-disk layout and write protocol
```
$HAWA_BLOB_DIR/                 host: ~/.hawa/blobs   container: /var/lib/hawa/blobs
  .hawa-blob-store              marker ("sha256-v1"). Core's /ready fails without it, so a missed bind mount can't write into an empty dir
  sha256/ab/<64hex>.<ext>       files 0444, dirs 0755
  tmp/<hex>.<rand>.part         same filesystem
```
How `put(bytes, mediaType)` works:
1. Compute `sha = sha256(bytes)`. Check `mediaType` against the bytes: images through `sniffImageType` (`packages/creative/src/studio/image-type.ts`, moved into contracts or duplicated as a 30-line magic-byte check); pptx starts with `PK\x03\x04`; pdf with `%PDF-`. A mismatch throws `BlobMediaTypeError`.
2. **Outside any transaction**, unless `final` already exists with the right size: `open(tmp,'wx',0o600)`, then write, `fh.sync()`, close, `chmod 0o444`.
3. **Short transaction** (the caller's `trx` if given):
   - `SELECT pg_advisory_xact_lock_shared(hashtextextended('hawa.blob:'||$sha,0))`
   - `INSERT INTO hawa.blobs(sha256,size,media_type) VALUES(...) ON CONFLICT (sha256) DO UPDATE SET unreferenced_since = NULL WHERE hawa.blobs.unreferenced_since IS NOT NULL RETURNING media_type, size`. A different stored `media_type` or size throws.
   - If `final` is missing: `mkdir -p` the shard (0755, fsync `sha256/` if it was created), `rename(tmp, final)`, then fsync the shard dir (`fs.open(dir,'r')` then `.sync()`). If `final` exists, unlink tmp. An existing target means the same bytes.
   - Commit. **Invariant: when the row commits, the file exists.**
4. On any error, remove tmp. A rename that is followed by a rollback leaves an orphan file, which the orphan sweep removes.

### 2.3 Migration 019 (`packages/db/migrations/019_blob_store.sql`)
Nothing here touches a column the running Core writes, so it is safe before the container swap.
```sql
BEGIN;
CREATE TABLE IF NOT EXISTS hawa.blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size BETWEEN 1 AND 104857600),
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp','image/gif','application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  unreferenced_since timestamptz          -- set by the mark phase, cleared when referenced again or re-put
);
CREATE INDEX IF NOT EXISTS blobs_unreferenced_idx ON hawa.blobs(unreferenced_since) WHERE unreferenced_since IS NOT NULL;
CREATE OR REPLACE FUNCTION hawa.protect_blob() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.sha256,NEW.size,NEW.media_type,NEW.created_at) IS DISTINCT FROM (OLD.sha256,OLD.size,OLD.media_type,OLD.created_at)
  THEN RAISE EXCEPTION 'A blob row is immutable except unreferenced_since' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
CREATE TRIGGER protect_blob BEFORE UPDATE ON hawa.blobs FOR EACH ROW EXECUTE FUNCTION hawa.protect_blob();
-- No tenant and no RLS: a hash reveals nothing. Serving authorises on the referencing row (ADR-035 §2.4).
REVOKE ALL ON hawa.blobs FROM PUBLIC;
GRANT SELECT, INSERT ON hawa.blobs TO hawa_app;
GRANT UPDATE (unreferenced_since) ON hawa.blobs TO hawa_app;   -- no DELETE: only the GC functions delete

-- The referencing row for payload pictures (task_events is append-only JSON and can hold no FK).
CREATE TABLE IF NOT EXISTS hawa.task_files (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  sha256 text NOT NULL REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('reference_image')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, role, sha256),
  FOREIGN KEY (tenant_id, task_id) REFERENCES hawa.tasks(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_files_sha_idx ON hawa.task_files(sha256);
ALTER TABLE hawa.task_files ENABLE ROW LEVEL SECURITY; ALTER TABLE hawa.task_files FORCE ROW LEVEL SECURITY;
CREATE POLICY task_files_tenant_scope ON hawa.task_files
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT ON hawa.task_files TO hawa_app;

-- New columns the old Core never writes, so these FKs are safe now.
ALTER TABLE hawa.design_studio_candidates ADD COLUMN IF NOT EXISTS composite_sha256 text
  REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT CHECK (composite_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE hawa.photo_cutouts
  ADD COLUMN IF NOT EXISTS png_sha256 text REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS shadow_sha256 text REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT;
-- Indexes for the RESTRICT checks and the mark phase (FKs on existing columns come in 020).
CREATE INDEX IF NOT EXISTS dsc_preview_sha_idx ON hawa.design_studio_candidates(preview_sha256);
CREATE INDEX IF NOT EXISTS dsc_composite_sha_idx ON hawa.design_studio_candidates(composite_sha256);
CREATE INDEX IF NOT EXISTS dsc_art_sha_idx ON hawa.design_studio_candidates(art_sha256);
CREATE INDEX IF NOT EXISTS canva_plan_source_sha_idx ON hawa.canva_design_plans(source_sha256);
CREATE INDEX IF NOT EXISTS canva_editable_sha_idx ON hawa.canva_editable_sources(sha256);
CREATE INDEX IF NOT EXISTS photo_cutouts_png_sha_idx ON hawa.photo_cutouts(png_sha256);
CREATE INDEX IF NOT EXISTS photo_cutouts_shadow_sha_idx ON hawa.photo_cutouts(shadow_sha256);
CREATE INDEX IF NOT EXISTS comparison_pairs_hawa_sha_idx ON hawa.comparison_pairs(hawa_sha256);
CREATE INDEX IF NOT EXISTS comparison_pairs_designer_sha_idx ON hawa.comparison_pairs(designer_sha256);

-- Let the new code stop writing inline bytes (the old code still writes them; harmless).
ALTER TABLE hawa.canva_editable_sources ALTER COLUMN content DROP NOT NULL;
ALTER TABLE hawa.comparison_pairs ALTER COLUMN hawa_png DROP NOT NULL, ALTER COLUMN designer_png DROP NOT NULL;
ALTER TABLE hawa.photo_cutouts ALTER COLUMN png DROP NOT NULL,
  ADD CONSTRAINT photo_cutouts_png_somewhere CHECK (png IS NOT NULL OR png_sha256 IS NOT NULL);
DO $$ DECLARE c text; BEGIN   -- the unnamed "planned needs source_content" CHECK from 007
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='hawa.canva_design_plans'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%source_content IS NOT NULL%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE hawa.canva_design_plans DROP CONSTRAINT %I', c); END IF; END $$;
ALTER TABLE hawa.canva_design_plans ADD CONSTRAINT canva_plan_planned_has_source
  CHECK (status <> 'planned' OR (result IS NOT NULL AND source_sha256 IS NOT NULL));

-- Every reference, in one place, for GC (a test checks it covers every FK to hawa.blobs).
CREATE OR REPLACE VIEW hawa.blob_references AS
  SELECT sha256 FROM hawa.task_files
  UNION ALL SELECT preview_sha256   FROM hawa.design_studio_candidates WHERE preview_sha256 IS NOT NULL
  UNION ALL SELECT composite_sha256 FROM hawa.design_studio_candidates WHERE composite_sha256 IS NOT NULL
  UNION ALL SELECT art_sha256       FROM hawa.design_studio_candidates WHERE art_sha256 IS NOT NULL
  UNION ALL SELECT source_sha256    FROM hawa.canva_design_plans WHERE source_sha256 IS NOT NULL
  UNION ALL SELECT sha256           FROM hawa.canva_editable_sources
  UNION ALL SELECT png_sha256       FROM hawa.photo_cutouts WHERE png_sha256 IS NOT NULL
  UNION ALL SELECT shadow_sha256    FROM hawa.photo_cutouts WHERE shadow_sha256 IS NOT NULL
  UNION ALL SELECT hawa_sha256      FROM hawa.comparison_pairs
  UNION ALL SELECT designer_sha256  FROM hawa.comparison_pairs;
REVOKE ALL ON hawa.blob_references FROM PUBLIC, hawa_app;
-- plus hawa.blob_gc_mark(), hawa.blob_gc_sweep(interval,int), hawa.blob_gc_claim_unlink(text): section 2.5
COMMIT;
```
**Migration 020** ships in the release after the copy backfill (release B). It adds the FKs on existing columns and validates them. `VALIDATE` fails the deploy at the migrate step, before containers swap, if any copy is incomplete. That is the gate.
```sql
ALTER TABLE hawa.design_studio_candidates
  ADD CONSTRAINT dsc_preview_blob_fk FOREIGN KEY (preview_sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT dsc_art_blob_fk     FOREIGN KEY (art_sha256)     REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;
ALTER TABLE hawa.canva_design_plans     ADD CONSTRAINT canva_plan_source_blob_fk FOREIGN KEY (source_sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;
ALTER TABLE hawa.canva_editable_sources ADD CONSTRAINT canva_editable_blob_fk   FOREIGN KEY (sha256)        REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;
ALTER TABLE hawa.comparison_pairs
  ADD CONSTRAINT comparison_hawa_blob_fk     FOREIGN KEY (hawa_sha256)     REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT comparison_designer_blob_fk FOREIGN KEY (designer_sha256) REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT NOT VALID;
-- then VALIDATE CONSTRAINT for each of the seven
```
**Migration 021** comes a week after the strip and one clean restore drill. It re-creates `hawa.protect_canva_plan_source()` without `source_content` first, because the 010 version references it and would fail at runtime. Then it drops `preview_png, composite_png, art_png, source_content, canva_editable_sources.content, photo_cutouts.png, shadow_png, hawa_png, designer_png` and their CHECKs, and updates `packages/db/src/types.ts:544-547`.

### 2.4 Referencing columns (all `ON DELETE RESTRICT`)
`task_files.sha256` (new); `design_studio_candidates.preview_sha256`, `composite_sha256` (new), `art_sha256`; `canva_design_plans.source_sha256`; `canva_editable_sources.sha256`; `photo_cutouts.png_sha256` and `shadow_sha256` (new); `comparison_pairs.hawa_sha256` and `designer_sha256`. The tenant is on each of those rows.

`photo_cutouts.source_sha256` stays unlinked. It hashes the upright variant, which is derived and not stored.

### 2.5 Garbage collection: mark and sweep, 14-day grace
The SQL functions are in 019. Each is `SECURITY DEFINER`, owned by the owner, `SET search_path = pg_catalog, hawa`, with `EXECUTE` granted to `hawa_app` and revoked from `PUBLIC`.
- `hawa.blob_gc_mark()` sets `unreferenced_since = now()` where it is NULL and the blob has no reference, and clears it where it is set and a reference exists. Returns `(marked, cleared)`.
- `hawa.blob_gc_sweep(p_grace interval, p_limit int DEFAULT 500) RETURNS TABLE(sha256, media_type)`. It refuses a grace under 7 days. It loops `SELECT … WHERE unreferenced_since < now()-p_grace AND created_at < now()-p_grace ORDER BY unreferenced_since LIMIT p_limit FOR UPDATE SKIP LOCKED`, skips anything still in `blob_references`, and deletes row by row in a sub-block with `EXCEPTION WHEN foreign_key_violation THEN NULL`. The FK is the safety net.
- `hawa.blob_gc_claim_unlink(p_sha256)` takes `pg_advisory_xact_lock(hashtextextended('hawa.blob:'||p_sha256,0))` and returns `NOT EXISTS (row)`. The CLI unlinks the file **inside that transaction, after the DELETE has committed**. A writer holds the same lock shared in `put()`. So either the writer runs later and rewrites the missing file, or the GC sees the re-inserted row and keeps the file.
- CLI `apps/core/src/tools/blob-gc.ts --grace-days ${HAWA_BLOB_GRACE_DAYS:-14} [--dry-run] [--limit 500]`, in this order:
  1. mark
  2. sweep until fewer than `limit` rows come back
  3. claim and unlink each swept blob
  4. orphan walk of `sha256/**`: files older than the grace with no row get a claim, then an unlink
  5. remove `tmp/*.part` older than 24 h
  6. print one JSON line `{marked, cleared, deleted, unlinked, orphans, tmp, bytesFreed, storeFiles, storeBytes}`
- Schedule: at the end of `nightly_backup.sh`, after the archive copy succeeds, via `docker exec hawa-production-core-1 node apps/core/dist/tools/blob-gc.js`. GC therefore never runs during a pack, and never without a fresh verified backup. A GC failure alerts but doesn't fail the backup. There is deliberately no timer in Core, in line with Phase 2's direction.

### 2.6 How the containers see the directory (`infra/docker/docker-compose.prod.yml`)
- `x-worker-environment` (line 11) gets `HAWA_BLOB_DIR: /var/lib/hawa/blobs`. The `x-worker` anchor (line 19) gets `volumes: ["${HAWA_BLOBS_DIR:-${HOME}/.hawa/blobs}:/var/lib/hawa/blobs"]`, so both colours mount it read-write. Phase 2.1 moves Telegram intake, and with it photo `put`, into the worker.
- `core` (line 80) gets environment `HAWA_BLOB_DIR: /var/lib/hawa/blobs` and `HAWA_BLOB_ACCEL_PREFIX: /_blobs/`, plus the same read-write volume.
- `nginx` (line 50) adds `- ${HAWA_BLOBS_DIR:-${HOME}/.hawa/blobs}:/srv/hawa-blobs:ro`.
- `cutout` gets **no mount in 3.1**. It receives the upright photo's bytes over the internal network. The upright variant is derived and not a blob, so a hash would not name what it cuts. Its PNG replies (base64 JSON, `server.py:108,112`) come back to Core, and Core `put`s them. Keep a commented `:/blobs:ro` line and a note. The future path is a read-only mount plus a `{"blob":"<sha>.<ext>"}` request form, if upright variants ever become blobs.
- `deploy.sh`, after the model check at `:166-171`: `install -d -m 0755 "$BLOBS" "$BLOBS/sha256"` and `install -d -m 0755 "$BLOBS/tmp"`, then write `.hawa-blob-store` if it is absent. Then a smoke step after health: put a probe blob through `docker exec core`, read it through nginx with a session and expect 200, and request `/_blobs/...` directly and expect 404.

### 2.7 Permissions
| Who | Container user | Access |
|---|---|---|
| Core | uid 10001 `hawa` (`Dockerfile.core:47,59`) | read-write |
| Worker, both colours | uid 10001 `hawa` (`Dockerfile.worker:33,41`) | read-write |
| nginx | workers run as uid 101 `nginx` (`nginx.conf:1`) | read-only; relies on the world-readable 0444 files and 0755 dirs |
| Cut-out | uid 10001 `cutout` (`Dockerfile.cutout:8,10`) | none |
| Host scripts | owner user (uid 501) | read for backups, write for restores. Restores `chmod 0444` files and `0755` dirs |

On Docker Desktop for Mac, bind-mount files belong to the host user and the container users can use them. On a Linux host, `chown -R 10001:10001 ~/.hawa/blobs`; add this to `infra/docker/README.md`.

Durability caveat: fsync through virtiofs ends in macOS `fsync`, not `F_FULLFSYNC`. The weekly `blob-verify` run and the restore drill catch any row whose file is missing.

### 2.8 Tests with a temp directory
- `vitest.config.ts` env gets `HAWA_BLOB_DIR: mkdtempSync(join(tmpdir(),'hawa-test-blobs-'))`, the same pattern as `spendStateDir` at `:46`.
- `packages/db/test-support/test-database-clone.ts:49-58`: each file that clones databases also gets its own `process.env.HAWA_BLOB_DIR`, created with `mkdtemp` plus the marker and removed in the existing `afterAll`. `HAWA_KEEP_TEST_DB=1` keeps it.
- Helper `createTestBlobStore(db)` in `packages/db/test-support/`.
- `createApp` gains `blobStore?: BlobStore` (`app.ts:271-311`) for injection.
- `HAWA_BLOB_FSYNC=off` is honoured only when `NODE_ENV=test`, and is off by default.

---

## 3. Serving

**Core helper** `apps/core/src/services/blob-response.ts`:
```ts
export async function blobResponse(c: Context, store: BlobStore, ref: BlobRef,
  o: { cacheControl?: string; disposition?: string; exposeSha?: boolean } = {}): Promise<Response>
```
- It always sets `Content-Type: ref.mediaType`, `Cache-Control: o.cacheControl ?? 'private, max-age=31536000, immutable'`, `X-Content-Type-Options: nosniff`, `Content-Disposition` when given, and `X-Content-SHA256` unless `exposeSha === false`.
- **Accel mode** (`HAWA_BLOB_ACCEL_PREFIX` set): status 200, empty body, `X-Accel-Redirect: /_blobs/sha256/ab/<hex>.<ext>`, built only from a validated hex and the extension map. No Content-Length.
- **Stream mode** (dev and tests): `store.open(ref)`, `Content-Length`, `ETag: "sha256-<hex>"`, and a 304 on `If-None-Match`.
- Every route authorises **on the referencing row**, under RLS through `withRlsContext`, never on the hash.

**nginx** (`infra/docker/nginx.conf`, inside `server {}`):
```nginx
# Internal only: Core answers X-Accel-Redirect after authorising on the referencing row (ADR-035).
location /_blobs/ {
    internal;
    alias /srv/hawa-blobs/;
    sendfile on;
    # add_header here replaces the server-level set (lines 81-85), so they are repeated.
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'none'; sandbox" always;
    add_header X-Content-SHA256 $upstream_http_x_content_sha256 always;   # empty (and omitted) for judge links
}
```
nginx keeps the upstream `Content-Type`, `Content-Disposition` and `Cache-Control` across X-Accel-Redirect. The deploy smoke test checks this with `curl -I`. The `mime.types` include at line 13 is the fallback.

**Routes:**

| Route | Authorises on | Cache-Control |
|---|---|---|
| `design-studio.routes.ts:206-268`. New path `/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/:kind/:sha256.png`, so the URL is immutable; revisions change the sha. The old paths stay one release with `no-store`. Uses `getCandidateById`, not `getCandidatesForRun`, and checks `sha256` equals the row's current column. | the candidate row | immutable |
| `comparison.routes.ts:137-147` (office) | pair row via `readPairImage`, rewritten to return a ref | `private, no-store` (unchanged) |
| `comparison.routes.ts:206-222` (judge) | judge session plus pair | `private, max-age=3600`, `inline; filename="design.png"`, `exposeSha:false` to keep the arms blinded |
| **New** `GET /v1/tasks/:taskId/files/:sha256` (reference photos) | `task_files` row | immutable |
| **New** `GET /v1/tasks/:taskId/exports/:exportId/content` | streams `canva_export_bytes` (stays bytea); the trigger makes the bytes immutable | immutable |

`GET /tasks/:id` (`app.ts:6587-6592`) selects `id, sha256, format, octet_length(content)` only. `previewUrl` at `app.ts:6640` becomes `/v1/tasks/${taskId}/exports/${exportRow.id}/content`.

**Desk changes:**
- `apps/desk/src/services/authorizedImage.ts`: `useAuthorizedImage(url?: string): { src?: string; failed: boolean }`. It passes `data:` and `blob:` URLs through. For other URLs it fetches with the headers from `services/auth.ts:61`, then `URL.createObjectURL`, keeps a per-session Map keyed by the immutable URL, and revokes on unmount. Also a `<AuthorizedImage>` component.
- `components/VectorInspector.tsx:21-30` uses the hook (callers `WorkScreen.tsx:1105` unchanged).
- `components/StudioPanel.tsx:137-140` (`getMediaUrl`), `691`, `879-884` use `<AuthorizedImage>`. Today these `<img>` tags send no credentials.
- `public/sw.js:115-135` skips caching for `/v1/**/content`, `/v1/tasks/*/files/*` and `*.png` under `/v1/`. Today it stores every authenticated response in Cache Storage.
- Once the Desk no longer needs query tokens, `verifyRequestAuth` (`app.ts:1432-1443`) should stop accepting `access_token` on `.png` and `/studio/` paths. That fits with the Phase 1.5 stream ticket.

---

## 4. Backups (`infra/backup/nightly_backup.sh`, `infra/ops/disk_cleanup.sh`) and the restore drill

The archive is incremental and encrypted, using the same cipher as today (`aes-256-cbc -pbkdf2 -iter 100000`, one openssl run per night rather than per file):
```
$ARCHIVE_DEST/blobs/blobpack_<STAMP>.tar.enc    new blobs since the last pack (tar of relative paths)
$ARCHIVE_DEST/blobs/index.tsv                   "<sha>.<ext>\t<pack>"; atomic write .new then mv
$ARCHIVE_DEST/hawa_<STAMP>.blobs                manifest: every blob file present right after the dump
```
Changes to `nightly_backup.sh`:
1. Keep dump then verify (`:43-60`), and time the dump (`DUMP_S`).
2. **Before** `dropdb "$VDB"` (move `:57` down), compute `REFS=$(psql -d "$VDB" -Atc 'SELECT DISTINCT sha256 FROM hawa.blob_references')`.
3. Build the manifest by walking `~/.hawa/blobs/sha256` into `snapshots/hawa_$STAMP.blobs`. Fail with "dump references N blobs not on disk" if REFS is not a subset of the manifest (`comm -23`). This is the nightly referential restore check, and it holds because the dump was taken first.
4. `NEW = manifest − index`. `tar -cf - -C "$BLOBS" -T newlist | openssl enc … -out blobs/blobpack_$STAMP.tar.enc.part`. Verify by decrypting and extracting into a temp dir under `$DIR`, then check `shasum -a 256` of each file equals its name. Rename `.part` to `.tar.enc`, append to the index, and copy the manifest into the archive. Unencrypted destinations write `.tar`.
5. Guard at the top: fail if `HAWA_BACKUP_ARCHIVE_KEEP >= HAWA_BLOB_GRACE_DAYS` (14 and 14 fails, so the default ARCHIVE_KEEP becomes 13, or the grace 15; the lead should pick).
6. Pruning, after `:107-113`: the needed set is the union of the retained dumps' manifests. Delete a pack when none of its index entries is needed, and rewrite the index. `--repack` (monthly) consolidates sparse packs.
7. GC step (section 2.5), logged.
8. The log line at `:115` gains `dump_s= blobs= blob_bytes= new_blobs= gc_deleted=`.

`disk_cleanup.sh`:
- `report()` (`:52-61`) adds `du -sh ~/.hawa/blobs` and `$ARCHIVE/blobs`.
- `:71-73` also deletes `$ARCHIVE/blobs/*.part` and `~/.hawa/blobs/tmp/*.part` older than a day.
- `:88-98` is documented, with a test, as never touching `$ARCHIVE/blobs/`. Its globs are `hawa_*` at depth 1.
- `watchdog.sh:139`: the disk figure includes the blob store.

**Restore drill.** New `infra/backup/restore_drill.sh`, a monthly launch agent in `install_launch_agents.sh:46-47`. The existing `backup_restore_drill.sh` is a schema-parity check only.
1. Take the newest archived `hawa_*.dump.enc` and its `.blobs` manifest.
2. Decrypt, `createdb hawa_drill_<stamp>`, `pg_restore --exit-on-error`.
3. Decrypt and extract only the packs the manifest needs (from the index) into `~/.hawa/drill/<stamp>/blobs`.
4. Run `node apps/core/dist/tools/blob-verify.js --db hawa_drill_… --dir …`. Every `hawa.blobs` row and every `blob_references` hash must have a file, with sha256 equal to the name and size equal to `blobs.size`. Missing must be 0.
5. Record `backup_drills` evidence: `{drill_type:'data_and_blobs', dump, blobs_checked, missing, rto_seconds}`.
6. Drop the database and remove the scratch dir. Update `runbooks/10_backup_restore.md` with these steps.

Pre-deploy dumps (`deploy.sh:221-231`) are rollback points for their own deploy only. The runbook should say so.

---

## 5. Moving existing rows: `scripts/blob_backfill.ts`

**How to run it:**
- `DATABASE_URL=<owner> HAWA_BLOB_DIR=… npx tsx scripts/blob_backfill.ts --phase reference_photos|plan_sources|candidates|cutouts|comparisons|all --mode copy|strip|verify [--batch 25] [--limit N] [--dry-run] [--measure]`.

**Preconditions it asserts:**
- 019 is applied.
- `rolsuper OR rolbypassrls`: every table has `FORCE ROW LEVEL SECURITY`, so the owner needs bypass.
- The store marker is present.
- For the production port 54332, it requires `--production` **and** a rehearsal receipt `~/.hawa/logs/blob_backfill_rehearsal.json`. The receipt records a `hawa_restore_*` database name, migration checksums identical to production, and zero verify failures.

**Modes:**
- **copy** never changes existing content. It `put`s the bytes, then writes the hash into a new column (`composite_sha256`, `png_sha256`, `shadow_sha256`) or adds `task_files` rows. For JSON rows, copy only puts and links.
- **strip** needs a verified blob (`read({verify:true})`, sha and size match). Then:
  - bytea columns go to NULL;
  - JSON: each of `{payload,studioOptions}`, `{studioOptions}`, `{payload}` and root gets `jsonb_set(x #- '{…,referenceImageBase64}', '{…,referenceImage}', ref)`;
  - outbox `requestHash` is recomputed with the same exported `computePayloadHash`. Otherwise a replay after the migration would raise `IdempotencyConflictError` (`task.repository.ts:486-498`);
  - `canva_design_plans.request` is rewritten the same way, but `request_hash` stays: it is historical evidence.
- **verify** reports rows still carrying bytes, refs without files, and JSON still containing `data:image`.

**Append-only triggers.** Each strip batch runs in one transaction as the owner:
- `ALTER TABLE … DISABLE TRIGGER <name>`, then UPDATE, then `ENABLE TRIGGER`, then COMMIT. DDL is transactional, so a crash leaves the trigger enabled.
- The names: `task_events_append_only` (`db/schema.sql:987`), `immutable_canva_plan` (007), `canva_editable_sources_immutable` (006), `protect_comparison_pair` (015).
- Each batch holds a SHARE ROW EXCLUSIVE lock for milliseconds, so intake briefly queues. Run it in a quiet hour.
- A test checks `pg_trigger.tgenabled='O'` afterwards.

**Resumable and idempotent.** Progress is the data itself. Copy selects `WHERE <bytes> IS NOT NULL AND (<ref> IS NULL OR NOT EXISTS blob)`. Strip selects `WHERE <bytes> IS NOT NULL AND EXISTS blob`. Batches use a keyset on `id`, and `put` is idempotent. SIGINT finishes the current batch. NDJSON progress goes to `~/.hawa/logs/blob_backfill_<stamp>.ndjson`. Undecodable data URIs are reported and left in place.

**Order and gates:**
1. Release A: store, 019, compose, nginx, backups. Code dual-writes in plan order (photos, then sources, candidates, cut-outs, comparisons), and readers prefer the blob and fall back to bytes.
2. Rehearse on a restored copy: restore the newest nightly dump into `hawa_restore_<stamp>` with blob dir `~/.hawa/blobs-rehearsal`, run `--phase all --mode copy`, then `strip`, then `verify`. Run `VACUUM (FULL, ANALYZE)` on `canva_design_plans, canva_editable_sources, design_studio_candidates, task_events, outbox_commands, photo_cutouts, comparison_pairs`. Measure.
3. Production copy.
4. Release B: 020 validates the FKs and the code stops writing bytes. The backups (section 4) must already have run green.
5. Production strip, then VACUUM FULL.
6. Release C: 021 after a week and one clean drill.

**Measuring (`--measure`):** `pg_database_size('hawa')`, per-table `pg_total_relation_size`, and `pg_dump -Fc --compress=zstd:long` wall time and size, before and after, into `output/plans/2026-09-24-architecture-programme/PHASE3_EVIDENCE.md`.
- **Production baseline:** 328 MB database; dump 41 MB on 2026-09-23 (`nightly_backup.sh:41-42`).
- **Expected:** database about 60 MB after VACUUM FULL; store about 155 MB (plans 120.5 MB, editable sources dedupe to 0, candidates 31.5 MB, 6 distinct photos, cut-outs about 1.1 MB).
- **Test (`hawa_repair`):** 348 MB now, about 175 MB of store after dedupe (122 of 203 sources are distinct).

**Restate:** nothing to move. Since 0.2 the claim strips pictures. After 3.1 a payload carries only the ~110 B ref. The drill confirms old journals have aged out by querying Restate's `sys_journal` for `data:image`.

---

## 6. Renderer: photos as files beside the SVG (`packages/creative`)

`svgToPngAsync(svg,w,h,options,files)` already writes sibling files (`render-layout-v2.ts:1846-1863`, name regex `^[a-z0-9-]+\.[a-z]+$`). Photo-upright (`photo-upright.ts:59-65`) and the logo prescale (`render-layout-v2.ts:1466-1551`) already use it. The changes:

- **`RenderLayoutOptions`** (`render-layout-v2.ts:53-68`) gains `photoFiles?: Array<{ bytes: Buffer; mediaType: BlobMediaType } | undefined>`. `photoDataUris` is deprecated, and during the transition it is converted to files internally.
- **`renderLayoutV2ToSvg`** (`:1561`) returns `files: Record<string, Buffer>`, collected by a small `SvgFiles` class: `add(bytes, kind) → "${kind}-${sha256.slice(0,16)}.${ext}"`, deduped, with the extension from `sniffImageType`. The file name becomes the `href`:
  - photos `:1689-1709`: pixel size from `imagePixelSize(bytes)` instead of `dataUriPixelSize`
  - cut-outs: `cutoutImageSvg` `:1407-1409` and `cutoutSource` in `photo-treatments.ts:335-344` take an `href`
  - art `:1603-1606`
  - logo, both prescaled and fallback, `:1720-1731`. The unprescaled logo is 1.5 MB.
- `renderLayoutV2Async` (`:1888-1896`), `renderLayoutV2` and `svgToPng` (`:1776-1837`, which gains a `files` parameter), and `renderAnnotatedLayoutV2` (`:1953`) pass `files` along.
- **`PhotoFragment`** (`photo-treatments.ts:93`) gains `files`. `bakePhotoFragment` (`transfer-v2.ts:89-92`) passes them, and `transfer-v2.ts:528` passes a file name, not a data URI.
- **`uprightPhotoDataUrl`** becomes `uprightPhoto(bytes) → {bytes, mediaType}`. It keeps **the same decisions**: the 7 MB rule becomes a byte threshold equivalent to the old data-URL length, so 3.1 changes no pixels. Removing that rule belongs to the ADR-036 gate.
- **Call sites:** `render.stage.ts:27`, `revise.stage.ts:118` and `edit.stage.ts:186` pass `photoFiles: ctx.photos?.map(p => ({ bytes: p.bytes, mediaType: p.mimeType }))`. `ContentPhoto` already carries `bytes` (`design-studio/types.ts:195-201`).
- **In memory, the studio pipeline keeps data URLs for model calls.** `requestImages` (`design-studio-service.ts:184-275`) reads refs through `task_files` joined to `blobs` (no JSON scan), falls back to the legacy base64 until release C, dedupes by sha256, and builds the data URL at the model boundary. The legacy planner (`canva-design-planner.ts:336-361`) does the same.
- **Guard:** `inlineDataUriMax(svg)` runs in both rasterisers. Over 100 KB it throws under `NODE_ENV=test` and logs `[render] inline data URI N bytes` in production. It becomes a throw after a clean week.

---

## 7. Tests and acceptance

**Unit, store** (`packages/db/test/blob-store.test.ts`, temp dir plus DB clone):
- Layout and modes (0444, 0755).
- Same bytes twice gives one file and one row; ten concurrent puts give one file.
- Media-type mismatch is refused.
- Injected fs faults (`BlobFs`) show the order write, sync, close, rename, dir sync, and leave no tmp behind.
- A size-corrupted file gives `BlobCorruptError`.

**GC** (`packages/db/test/blob-gc.test.ts`):
- A referenced blob is never deleted, parameterised over every `blob_references` branch, and a direct DELETE is refused by the FK.
- Within grace it is kept; past grace it is deleted and unlinked.
- Re-referencing clears `unreferenced_since`.
- The race between a writer's put and the sweep's unlink is tested with two connections: the file survives.
- Orphan and tmp sweeps work.
- **Coverage test:** every `pg_constraint` with `confrelid='hawa.blobs'::regclass` appears in `blob_references`.

**Migrations:** `schema-upgrade.test.ts:18` gains 019; 020 fails on a seeded candidate whose `preview_sha256` has no blob.

**Intake** (new `apps/core/test/task-created-payload-size.test.ts`):
- A 12 MP JPEG from Telegram gives `task.created` ≤ 4 KB, no `data:` in `outbox_commands`, `task_events` or the captured Restate body, exactly one file, and one `task_files` row.
- A bilingual request still gives one file.
- Replaying the same update gives no idempotency conflict.

**Existing tests** get ref fixtures, plus one legacy-row case each: `early-reference-image`, `late-reference-image`, `question-followups(-review)`, `photos-as-content`, `telegram-understanding`, `telegram-requester-loop`, `studio-run-guards`, `canva-design-planner`, `apps/worker/test/outbox-claims`.

**Renderer** (`packages/creative/test/render-no-inline-rasters.test.ts`):
- Fixtures: an EXIF-6 12 MP JPEG, a 20 MB PNG, a cut-out with glow and outline, an art layer, the unprescaled logo.
- A spy on every SVG given to either rasteriser checks no data URI is over 100 KB.
- Output is pixel-identical to the data-URI baseline for the same bytes.
- Transfer bake fragments carry their files.

**Serving** (`apps/core/test/blob-serving.test.ts`):
- In accel mode: `X-Accel-Redirect` equals `/_blobs/sha256/ab/<hex>.png`, the body is empty, and the headers are as specified.
- Another tenant, a revoked judge or a stale sha gets 404 with no accel header.
- Stream mode returns the same bytes.
- `GET /tasks/:id` has no `data:`, `previewUrl` is a `/v1/` path, and the body is under 8 KB.
- An nginx config test checks `internal` and that the alias matches the compose mount. The deploy smoke test does it live.

**Backups:**
- Bash tests in the style of `packages/testkit/test/deploy-sh-worker-steps.test.ts`: an incremental second pack has 0 new files; pruning keeps packs a retained manifest still lists; a missing referenced blob fails the nightly; the ARCHIVE_KEEP versus grace guard works; `disk_cleanup` leaves `blobs/` untouched.
- Backfill test: seeded legacy rows in each table go through copy, strip and verify. A second run does nothing, an aborted run resumes, and the triggers are enabled afterwards.

**Acceptance** (lead re-runs):
1. Payload size:
```sql
SELECT count(*) FILTER (WHERE payload::text ~ 'data:[a-z]+/[^;]+;base64,') AS inline,
       count(*) FILTER (WHERE octet_length(payload::text) > 4096
         AND octet_length(coalesce(payload->>'rawRequestText','')||coalesce(payload->>'designInstructions','')) <= 2048) AS over
FROM hawa.outbox_commands WHERE command_type IN ('task.created','task.dispatch');
```
   Both counts must be 0, on the test DB after backfill and in production after cutover. The same `inline` check runs on `task_events.data` and `canva_design_plans.request`.
2. No data URI over 100 KB in any SVG: the renderer test, plus zero production guard logs for a week.
3. Database size and dump time before and after are recorded in `PHASE3_EVIDENCE.md`.
4. `restore_drill.sh` passes with `missing=0`, recorded in `hawa.backup_drills`.

### Critical Files for Implementation
- /Users/hawzhin/Hawdesign/packages/db/migrations/019_blob_store.sql (new; plus 020 and 021), with /Users/hawzhin/Hawdesign/packages/db/src/upgrade.ts and /Users/hawzhin/Hawdesign/packages/db/test/schema-upgrade.test.ts
- /Users/hawzhin/Hawdesign/packages/db/src/blobs/store.ts and gc.ts (new), /Users/hawzhin/Hawdesign/packages/db/src/repositories/task.repository.ts, /Users/hawzhin/Hawdesign/packages/db/src/repositories/design-studio.repository.ts
- /Users/hawzhin/Hawdesign/apps/core/src/app.ts (intake 4456-4510 and all `referenceImageBase64` sites; `GET /tasks/:id` 6556-6640), /Users/hawzhin/Hawdesign/apps/core/src/services/design-studio/design-studio-service.ts, /Users/hawzhin/Hawdesign/apps/core/src/routes/design-studio.routes.ts
- /Users/hawzhin/Hawdesign/packages/creative/src/studio/render-layout-v2.ts, with photo-treatments.ts, photo-upright.ts, transfer-v2.ts
- /Users/hawzhin/Hawdesign/infra/docker/docker-compose.prod.yml, /Users/hawzhin/Hawdesign/infra/docker/nginx.conf, /Users/hawzhin/Hawdesign/infra/backup/nightly_backup.sh, /Users/hawzhin/Hawdesign/infra/ops/disk_cleanup.sh