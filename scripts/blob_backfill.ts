#!/usr/bin/env tsx
/**
 * Moves the bytes already in the database into the content-addressed file store (ADR-035,
 * FILESTORE_DESIGN.md section 5).
 *
 *   DATABASE_URL=<owner> HAWA_BLOB_DIR=<store> npx tsx scripts/blob_backfill.ts \
 *     --phase reference_photos|plan_sources|candidates|cutouts|comparisons|all \
 *     --mode copy|verify|strip [--batch 25] [--limit N] [--dry-run] [--log <file.ndjson>] [--measure]
 *     [--write-receipt [--receipt <file>]]   (verify on a hawa_restore_* copy: the rehearsal receipt)
 *     [--production [--receipt <file>] [--accept-left-as-is N]]   (copy on production, after a rehearsal)
 *
 * Modes:
 *   copy    puts each row's bytes to the store and links them: a hash column the row lacks
 *           (composite_sha256, png_sha256, shadow_sha256), or a hawa.task_files row for a task's
 *           reference photo. It never changes the bytes, the JSON or an existing hash, so it needs no
 *           trigger disabled and can run while Core runs.
 *   verify  reports rows whose bytes are not in the store yet, stored hashes whose file is missing or
 *           differs, hashes with no file row and no bytes to copy (release B's foreign keys reject
 *           those: blocksForeignKey), and JSON still carrying a data:image URI. Changes nothing.
 *   strip   (this release: test databases and restored copies only) sets the bytea columns of rows
 *           whose file the store has, verified by hash, to NULL. Each batch runs in one transaction
 *           that disables the table's append-only trigger, updates and enables it again; DDL is
 *           transactional, so a crash leaves the trigger enabled. Reference photos in JSON are not
 *           stripped yet: readers still read the base64 until the Telegram intake moves (refused).
 *
 * Progress is the data itself: copy selects rows whose bytes are present and not yet in the store
 * (reference photos: every photo, skipped when its hash is already linked to its task), strip rows whose
 * bytes are present and whose file is, in keyset order on the row id, and put() is
 * idempotent. So a second run does nothing, and a run stopped anywhere (SIGINT finishes the row in
 * hand; strip, the rows of its batch already verified) resumes where it stopped. Undecodable data URIs
 * and hash mismatches are reported and left.
 *
 * Exit status: 0 done and clean; 1 done with problems to read; 3 stopped (a signal or --limit) with
 * rows left, so run it again; 2 refused or failed.
 *
 * Preconditions, asserted before anything is read: migration 019 is applied; the role bypasses row-level
 * security (every table forces it); the store's marker is present. Production (port 54332 or the
 * database named hawa) is refused unless --production is given with a rehearsal receipt
 * (~/.hawa/logs/blob_backfill_rehearsal.json: a hawa_restore_* database, its migration checksums equal
 * to the target's, zero verify failures, and --accept-left-as-is equal to the number of rows it left as
 * they are), and strip is refused there whatever is given.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BlobStore, createDb, sql, type Database, type Kysely } from '../packages/db/src/index.js';
import { sniffBlobMediaType, type BlobMediaType } from '../packages/contracts/src/blobs.js';

export const PHASES = ['reference_photos', 'plan_sources', 'candidates', 'cutouts', 'comparisons'] as const;
export type Phase = (typeof PHASES)[number];
export type Mode = 'copy' | 'verify' | 'strip';

const PPTX: BlobMediaType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface BackfillProblem {
  table: string;
  id: string;
  problem: string;
  /**
   * A row copy leaves as it is on purpose (an undecodable photo, bytes that do not match their hash
   * or are not the type the column holds). It cannot be fixed by running copy again, so a rehearsal
   * lists these apart and production copy asks for them to be accepted by count.
   */
  leftAsIs?: boolean;
  /**
   * The row's hash column names a file the store has no row for. Release B's foreign keys
   * (output/plans/2026-09-24-architecture-programme/staged/blob_fks.sql) fail to validate while any
   * such row exists, so a rehearsal counts them apart: copy cannot mend them, a person must decide.
   */
  blocksForeignKey?: boolean;
}

export interface PhaseReport {
  phase: Phase;
  mode: Mode;
  /** Rows looked at. */
  scanned: number;
  /** Files put to the store (copy), whether or not the store already had them. */
  stored: number;
  /** Hash columns or task_files rows written (copy). */
  linked: number;
  /** Rows whose bytes were set to NULL (strip). */
  stripped: number;
  /** verify: rows still holding bytes the store does not have. */
  notCopied: number;
  /** verify: rows whose bytes the store has, not yet stripped. */
  strippable: number;
  /** verify: JSON rows still carrying a data:image URI. */
  inlineJson: number;
  problems: BackfillProblem[];
  /**
   * Stopped by --limit or a signal with a row left that this mode would write. Rows already linked
   * and rows left as they are do not count: a run that stops just as its last writable row is done
   * has finished.
   */
  stoppedEarly: boolean;
}

export interface BackfillOptions {
  db: Kysely<Database>;
  store: BlobStore;
  phases: readonly Phase[];
  mode: Mode;
  batch?: number;
  /** At most this many rows written in the whole run (copy and strip); a later run resumes. */
  limit?: number;
  dryRun?: boolean;
  log?: (line: Record<string, unknown>) => void;
  /** Checked before each row that would be written: SIGINT finishes the row in hand, then stops. */
  shouldStop?: () => boolean;
}

// ---- Target and preconditions ----

export interface TargetCheck {
  databaseUrl: string;
  /** current_database() of the connection, when known. */
  database?: string;
  mode: Mode;
  production: boolean;
  receiptPath?: string;
  /** The target's migration checksums, to compare with the receipt's. */
  migrations?: Record<string, string>;
  /** --accept-left-as-is N: the number of rows the rehearsal left as they are, read and accepted. */
  acceptLeftAsIs?: number;
}

/** Production is the server on port 54332 or the database named hawa, however it is reached. */
export function isProductionTarget(databaseUrl: string, database?: string): boolean {
  let port = '';
  let name = database ?? '';
  try {
    const u = new URL(databaseUrl);
    port = u.port;
    if (!name) name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return true; // Unreadable: treated as the worst case.
  }
  return port === '54332' || name === 'hawa';
}

/** Throws unless this run may touch this database. No connection is made. */
export function assertTargetAllowed(t: TargetCheck): void {
  if (!isProductionTarget(t.databaseUrl, t.database)) return;
  if (t.mode === 'strip') {
    throw new Error('Refused: strip does not run against production in this release (ADR-035 release B strips, after the backups and a rehearsal).');
  }
  if (!t.production) throw new Error('Refused: this is production (port 54332 or database hawa); pass --production with a rehearsal receipt.');
  const receiptPath = t.receiptPath ?? path.join(os.homedir(), '.hawa/logs/blob_backfill_rehearsal.json');
  let receipt: { database?: string; verifyFailures?: number; leftAsIs?: unknown[]; migrations?: Record<string, string> };
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch {
    throw new Error(`Refused: no rehearsal receipt at ${receiptPath}; rehearse on a restored copy first.`);
  }
  if (!/^hawa_restore_[A-Za-z0-9_]+$/.test(String(receipt.database ?? ''))) throw new Error('Refused: the rehearsal receipt is not from a hawa_restore_* database.');
  if (receipt.verifyFailures !== 0) throw new Error('Refused: the rehearsal did not verify clean.');
  // Rows copy leaves as they are never become clean by copying; they are accepted by count, so a new
  // bad row since the rehearsal (or a different receipt) is refused rather than waved through.
  const leftAsIs = Array.isArray(receipt.leftAsIs) ? receipt.leftAsIs.length : 0;
  if (leftAsIs !== (t.acceptLeftAsIs ?? 0)) {
    throw new Error(`Refused: the rehearsal left ${leftAsIs} row(s) as they are (listed in the receipt); pass --accept-left-as-is ${leftAsIs} once they are read and accepted.`);
  }
  if (!t.migrations || JSON.stringify(sortKeys(receipt.migrations ?? {})) !== JSON.stringify(sortKeys(t.migrations))) {
    throw new Error("Refused: the rehearsal's migration checksums differ from this database's.");
  }
}

const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export async function migrationChecksums(db: Kysely<Database>): Promise<Record<string, string>> {
  const rows = (await sql<{ name: string; sha256: string }>`SELECT name, sha256 FROM hawa.schema_upgrades ORDER BY name`.execute(db)).rows;
  return Object.fromEntries(rows.map((r) => [r.name, r.sha256]));
}

/** 019 applied, row-level security bypassed, the store's marker present. */
export async function assertPreconditions(db: Kysely<Database>, store: BlobStore): Promise<void> {
  const applied = (await sql<{ ok: boolean }>`SELECT to_regclass('hawa.blobs') IS NOT NULL AND to_regclass('hawa.task_files') IS NOT NULL AS ok`.execute(db)).rows[0];
  if (!applied?.ok) throw new Error('Migration 019 (the file store) is not applied to this database.');
  const role = (await sql<{ ok: boolean }>`SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`.execute(db)).rows[0];
  if (!role?.ok) throw new Error('The backfill runs as the owner with BYPASSRLS (or a superuser): every table forces row-level security.');
  await store.assertReady();
}

// ---- Helpers ----

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The bytes of a base64 image data URI and their type, or a reason it is not one. */
export function decodeImageDataUri(uri: unknown): { bytes: Buffer; mediaType: BlobMediaType } | { problem: string } {
  if (typeof uri !== 'string') return { problem: 'not a string' };
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri);
  if (!m) return { problem: 'not a base64 data URI' };
  const bytes = Buffer.from(m[2], 'base64');
  const mediaType = sniffBlobMediaType(bytes);
  if (!mediaType || !mediaType.startsWith('image/')) return { problem: `its bytes are ${mediaType ?? 'no image type the store knows'}` };
  return { bytes, mediaType };
}

/** Why a row whose bytes differ from the stored file its hash names is left as it is. */
function differMessage(src: ByteaSource, sha: string, actual: string): string {
  return `${src.bytes} hashes to ${actual.slice(0, 12)}…, not to the stored file ${src.sha} names (${sha.slice(0, 12)}…); left as it is`;
}

/** Runs one strip batch with the table's protective trigger disabled, and enabled again, in one transaction. */
async function withTriggerDisabled<T>(db: Kysely<Database>, table: string, trigger: string | null, fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    if (trigger) await sql`ALTER TABLE ${sql.raw(`hawa.${table}`)} DISABLE TRIGGER ${sql.raw(trigger)}`.execute(trx);
    const out = await fn(trx);
    if (trigger) await sql`ALTER TABLE ${sql.raw(`hawa.${table}`)} ENABLE TRIGGER ${sql.raw(trigger)}`.execute(trx);
    return out;
  });
}

/** A bytea column that moves to the store, with the hash that names its file. */
interface ByteaSource {
  table: string;
  bytes: string;
  sha: string;
  /** The hash column is new (019): copy writes it. Otherwise it already names the bytes and copy only checks it. */
  shaIsNew: boolean;
  expected: BlobMediaType | 'image';
  /** The trigger strip disables for its batch. */
  trigger: string | null;
}

const BYTEA_SOURCES: Record<Exclude<Phase, 'reference_photos'>, ByteaSource[]> = {
  plan_sources: [
    { table: 'canva_design_plans', bytes: 'source_content', sha: 'source_sha256', shaIsNew: false, expected: PPTX, trigger: 'immutable_canva_plan' },
    { table: 'canva_editable_sources', bytes: 'content', sha: 'sha256', shaIsNew: false, expected: PPTX, trigger: 'canva_editable_sources_immutable' },
  ],
  candidates: [
    { table: 'design_studio_candidates', bytes: 'preview_png', sha: 'preview_sha256', shaIsNew: false, expected: 'image', trigger: null },
    { table: 'design_studio_candidates', bytes: 'composite_png', sha: 'composite_sha256', shaIsNew: true, expected: 'image', trigger: null },
    { table: 'design_studio_candidates', bytes: 'art_png', sha: 'art_sha256', shaIsNew: false, expected: 'image', trigger: null },
  ],
  cutouts: [
    { table: 'photo_cutouts', bytes: 'png', sha: 'png_sha256', shaIsNew: true, expected: 'image', trigger: null },
    { table: 'photo_cutouts', bytes: 'shadow_png', sha: 'shadow_sha256', shaIsNew: true, expected: 'image', trigger: null },
  ],
  comparisons: [
    { table: 'comparison_pairs', bytes: 'hawa_png', sha: 'hawa_sha256', shaIsNew: false, expected: 'image', trigger: 'protect_comparison_pair' },
    { table: 'comparison_pairs', bytes: 'designer_png', sha: 'designer_sha256', shaIsNew: false, expected: 'image', trigger: 'protect_comparison_pair' },
  ],
};

/** JSON that carries a reference photo: the task it belongs to and where in the JSON the photo is. */
interface JsonSource {
  table: string;
  task: string;
  column: string;
  /** SQL expression for the photo's data URI, over alias r. */
  image: string;
  where: string;
}

const JSON_SOURCES: JsonSource[] = [
  {
    table: 'task_events',
    task: 'task_id',
    column: 'data',
    image: `coalesce(r.data->'payload'->'studioOptions'->>'referenceImageBase64', r.data->'studioOptions'->>'referenceImageBase64')`,
    where: `r.event_type = 'task.created'`,
  },
  {
    table: 'outbox_commands',
    task: 'aggregate_id',
    column: 'payload',
    image: `coalesce(r.payload->'studioOptions'->>'referenceImageBase64', r.payload->>'referenceImageBase64')`,
    where: `r.command_type IN ('task.created', 'task.dispatch') AND r.aggregate_type = 'task'`,
  },
  {
    table: 'canva_design_plans',
    task: 'task_id',
    column: 'request',
    image: `r.request->>'referenceImageBase64'`,
    where: 'true',
  },
];

// ---- The run ----

export async function runBackfill(o: BackfillOptions): Promise<PhaseReport[]> {
  const batch = Math.max(1, Math.min(500, o.batch ?? 25));
  const log = o.log ?? (() => {});
  let budget = o.limit ?? Number.POSITIVE_INFINITY;
  const reports: PhaseReport[] = [];
  const stop = () => budget <= 0 || Boolean(o.shouldStop?.());
  // Every exit below that sets stoppedEarly is taken just before a row this mode would write, never
  // before a batch: a batch may hold only rows already linked or left as they are, which are not work.

  for (const phase of o.phases) {
    const report: PhaseReport = { phase, mode: o.mode, scanned: 0, stored: 0, linked: 0, stripped: 0, notCopied: 0, strippable: 0, inlineJson: 0, problems: [], stoppedEarly: false };
    reports.push(report);
    const problem = (table: string, id: string, what: string, leftAsIs = false, blocksForeignKey = false) => {
      const flags = { ...(leftAsIs ? { leftAsIs } : {}), ...(blocksForeignKey ? { blocksForeignKey } : {}) };
      report.problems.push({ table, id, problem: what, ...flags });
      log({ phase, mode: o.mode, table, id, problem: what, ...flags });
    };

    if (phase === 'reference_photos') {
      if (o.mode === 'strip') {
        problem('*', '*', 'refused: reference photos in JSON are stripped only once every reader reads hawa.task_files (after the Telegram intake moves)');
        continue;
      }
      // Each photo is compared by its hash, not by its task: a task may carry several different photos
      // (an event, a later dispatch, a planner request), and each must be in hawa.task_files. The JSON is
      // decoded here rather than in SQL, so an undecodable photo is a reported problem, not a failed query.
      for (const src of JSON_SOURCES) {
        if (o.mode === 'verify') {
          const n = (await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.raw(`hawa.${src.table}`)} r WHERE ${sql.raw(src.where)} AND r.${sql.raw(src.column)}::text ~ 'data:image/[a-z]+;base64,'`.execute(o.db)).rows[0];
          report.inlineJson += Number(n?.n ?? 0);
        }
        let after = '00000000-0000-0000-0000-000000000000';
        for (;;) {
          const rows = (
            await sql<{ id: string; tenant_id: string; task_id: string; image: string }>`
              SELECT r.id::text AS id, r.tenant_id::text AS tenant_id, r.${sql.raw(src.task)}::text AS task_id, ${sql.raw(src.image)} AS image
              FROM ${sql.raw(`hawa.${src.table}`)} r
              WHERE ${sql.raw(src.where)} AND ${sql.raw(src.image)} IS NOT NULL AND r.id > ${after}::uuid
                AND EXISTS (SELECT 1 FROM hawa.tasks t WHERE t.id = r.${sql.raw(src.task)} AND t.tenant_id = r.tenant_id)
              ORDER BY r.id LIMIT ${batch}`.execute(o.db)
          ).rows;
          if (!rows.length) break;
          for (const row of rows) {
            after = row.id;
            report.scanned++;
            const decoded = decodeImageDataUri(row.image);
            if ('problem' in decoded) {
              problem(src.table, row.id, `undecodable reference photo: ${decoded.problem}; left as it is`, true);
              continue;
            }
            const photoSha = sha256(decoded.bytes);
            const linked = await sql`SELECT 1 FROM hawa.task_files
              WHERE tenant_id = ${row.tenant_id}::uuid AND task_id = ${row.task_id}::uuid AND role = 'reference_image' AND sha256 = ${photoSha}`.execute(o.db);
            if (linked.rows.length) continue;
            if (o.mode === 'verify') {
              report.notCopied++;
              continue;
            }
            if (stop()) {
              report.stoppedEarly = true;
              break;
            }
            if (o.dryRun) continue;
            const ref = await o.store.put(decoded.bytes, decoded.mediaType);
            report.stored++;
            const inserted = await sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role)
              VALUES (${row.tenant_id}::uuid, ${row.task_id}::uuid, ${ref.sha256}, 'reference_image') ON CONFLICT DO NOTHING`.execute(o.db);
            if (Number(inserted.numAffectedRows ?? 0) > 0) report.linked++;
            budget--;
            log({ phase, mode: o.mode, table: src.table, id: row.id, task: row.task_id, sha256: ref.sha256 });
          }
          if (report.stoppedEarly) break;
        }
      }
      continue;
    }

    for (const src of BYTEA_SOURCES[phase]) {
      const table = sql.raw(`hawa.${src.table}`);
      const bytesCol = sql.raw(src.bytes);
      const shaCol = sql.raw(src.sha);
      if (o.mode === 'verify') {
        const counts = (await sql<{ strippable: string }>`
          SELECT count(*) FILTER (WHERE r.${bytesCol} IS NOT NULL AND encode(sha256(r.${bytesCol}), 'hex') = r.${shaCol}
            AND EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = r.${shaCol})) AS strippable
          FROM ${table} r`.execute(o.db)).rows[0];
        report.strippable += Number(counts?.strippable ?? 0);
        // Bytes that do not hash to the stored file their hash names: copy skips the row (the file is
        // there) and strip's update skips it (the bytes differ), so without this nothing would ever say.
        // The foreign key is satisfied; a person decides which of the two pictures the row means.
        const differ = (await sql<{ id: string; sha: string; actual: string }>`
          SELECT r.id::text AS id, r.${shaCol} AS sha, encode(sha256(r.${bytesCol}), 'hex') AS actual FROM ${table} r
          WHERE r.${bytesCol} IS NOT NULL AND encode(sha256(r.${bytesCol}), 'hex') <> r.${shaCol}
            AND EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = r.${shaCol}) ORDER BY r.id`.execute(o.db)).rows;
        for (const d of differ) {
          report.scanned++;
          problem(src.table, d.id, differMessage(src, d.sha, d.actual), true);
        }
        // Every stored hash a row names must have its file, with those bytes.
        const named = (await sql<{ id: string; sha: string }>`SELECT r.id::text AS id, r.${shaCol} AS sha FROM ${table} r
          JOIN hawa.blobs b ON b.sha256 = r.${shaCol}`.execute(o.db)).rows;
        for (const n of named) {
          report.scanned++;
          try {
            await o.store.read(n.sha, { verify: true });
          } catch (err) {
            problem(src.table, n.id, `${src.sha} ${n.sha.slice(0, 12)}…: ${(err as Error).message}`);
          }
        }
        // A hash with no file row and no bytes to copy it from: nothing can mend it by copying, and
        // release B's foreign key rejects it. (A column 019 added has its foreign key already.)
        const dangling = (await sql<{ id: string; sha: string }>`SELECT r.id::text AS id, r.${shaCol} AS sha FROM ${table} r
          WHERE r.${bytesCol} IS NULL AND r.${shaCol} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = r.${shaCol}) ORDER BY r.id`.execute(o.db)).rows;
        for (const d of dangling) {
          report.scanned++;
          problem(src.table, d.id, `${src.sha} ${d.sha.slice(0, 12)}… names a file the store does not have, and the row holds no bytes to copy it from; left as it is`, true, true);
        }
        // The rows not copied yet are then read as copy reads them (below), so those copy would leave
        // as they are are told apart from those it would copy.
      }

      let after = '00000000-0000-0000-0000-000000000000';
      while (!report.stoppedEarly) {
        if (o.mode === 'copy' || o.mode === 'verify') {
          const rows = (await sql<{ id: string; bytes: Buffer; sha: string | null }>`
            SELECT r.id::text AS id, r.${bytesCol} AS bytes, r.${shaCol} AS sha FROM ${table} r
            WHERE r.${bytesCol} IS NOT NULL AND r.id > ${after}::uuid
              AND (r.${shaCol} IS NULL OR NOT EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = r.${shaCol}))
            ORDER BY r.id LIMIT ${batch}`.execute(o.db)).rows;
          if (!rows.length) break;
          for (const row of rows) {
            after = row.id;
            report.scanned++;
            const bytes = Buffer.from(row.bytes);
            const actual = sha256(bytes);
            if (row.sha && row.sha !== actual) {
              problem(src.table, row.id, `${src.sha} says ${row.sha.slice(0, 12)}…, the bytes hash to ${actual.slice(0, 12)}…; left as it is`, true, true);
              continue;
            }
            const mediaType = sniffBlobMediaType(bytes);
            if (!mediaType || (src.expected === 'image' ? !mediaType.startsWith('image/') : mediaType !== src.expected)) {
              // Its hash, when it has one, names no file row (copy selects only those): a foreign key blocker.
              problem(src.table, row.id, `${src.bytes} is ${mediaType ?? 'of no type the store knows'}; left as it is`, true, Boolean(row.sha));
              continue;
            }
            if (o.mode === 'verify') {
              report.notCopied++;
              continue;
            }
            if (stop()) {
              report.stoppedEarly = true;
              break;
            }
            if (o.dryRun) continue;
            await o.store.put(bytes, mediaType);
            report.stored++;
            if (!row.sha) {
              // Core may have replaced the bytes since the select (copy runs while Core runs): link only
              // bytes that still hash to what was stored, or the row would name the old picture.
              const linked = await sql`UPDATE ${table} SET ${shaCol} = ${actual}
                WHERE id = ${row.id}::uuid AND ${shaCol} IS NULL AND encode(sha256(${bytesCol}), 'hex') = ${actual}`.execute(o.db);
              if (Number(linked.numAffectedRows ?? 0) > 0) report.linked++;
              else log({ phase, mode: o.mode, table: src.table, column: src.bytes, id: row.id, note: 'bytes changed since the select; linked on the next run' });
            }
            budget--;
            log({ phase, mode: o.mode, table: src.table, column: src.bytes, id: row.id, sha256: actual });
          }
          continue;
        }

        // strip: rows whose bytes the store has, verified by hash, in one transaction per batch.
        const rows = (await sql<{ id: string; sha: string; actual: string }>`
          SELECT r.id::text AS id, r.${shaCol} AS sha, encode(sha256(r.${bytesCol}), 'hex') AS actual FROM ${table} r
          WHERE r.${bytesCol} IS NOT NULL AND r.id > ${after}::uuid
            AND EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = r.${shaCol})
          ORDER BY r.id LIMIT ${batch}`.execute(o.db)).rows;
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
        const verified: string[] = [];
        for (const row of rows) {
          report.scanned++;
          if (row.actual !== row.sha) {
            problem(src.table, row.id, `not stripped: ${differMessage(src, row.sha, row.actual)}`, true);
            continue;
          }
          try {
            await o.store.read(row.sha, { verify: true });
          } catch (err) {
            problem(src.table, row.id, `not stripped: ${(err as Error).message}`);
            continue;
          }
          // The budget is spent as rows join the batch, so --limit strips exactly that many.
          if (stop()) {
            report.stoppedEarly = true;
            break;
          }
          verified.push(row.id);
          if (!o.dryRun) budget--;
        }
        if (o.dryRun || !verified.length) continue;
        const done = await withTriggerDisabled(o.db, src.table, src.trigger, async (trx) =>
          sql`UPDATE ${table} r SET ${bytesCol} = NULL
            WHERE r.id = ANY(${verified}::uuid[]) AND r.${bytesCol} IS NOT NULL
              AND encode(sha256(r.${bytesCol}), 'hex') = r.${shaCol}`.execute(trx)
        );
        const n = Number(done.numAffectedRows ?? 0);
        report.stripped += n;
        // A row whose bytes changed since the select was not stripped and did not spend the budget.
        budget += verified.length - n;
        log({ phase, mode: o.mode, table: src.table, column: src.bytes, stripped: n, through: after });
      }
    }
  }
  return reports;
}

/**
 * The receipt a production copy asks for (assertTargetAllowed), from a verify run on a restored copy:
 * written by `--mode verify --write-receipt` against a hawa_restore_* database. Its verifyFailures
 * counts every problem and every row not yet copied, so only a clean rehearsal lets production run.
 * Rows copy leaves as they are on purpose are listed apart (leftAsIs): running copy again cannot fix
 * them, so they would otherwise block production for good; they are accepted by count instead.
 */
export function rehearsalReceipt(database: string, migrations: Record<string, string>, reports: PhaseReport[]) {
  if (!/^hawa_restore_[A-Za-z0-9_]+$/.test(database)) throw new Error(`A rehearsal receipt comes from a hawa_restore_* database, not ${database}`);
  if (reports.some((r) => r.mode !== 'verify')) throw new Error('A rehearsal receipt is written by a verify run');
  const verifyFailures = reports.reduce((n, r) => n + r.problems.filter((p) => !p.leftAsIs).length + r.notCopied, 0);
  const leftAsIs = reports.flatMap((r) =>
    r.problems.filter((p) => p.leftAsIs).map(({ table, id, problem, blocksForeignKey }) => ({ table, id, problem, ...(blocksForeignKey ? { blocksForeignKey } : {}) }))
  );
  // Release B's foreign keys fail to validate until each of these is decided (FILESTORE_DESIGN.md 5).
  const foreignKeyBlockers = reports.reduce((n, r) => n + r.problems.filter((p) => p.blocksForeignKey).length, 0);
  return { database, migrations, verifyFailures, leftAsIs, foreignKeyBlockers, phases: reports.map((r) => r.phase), at: new Date().toISOString() };
}

/** Database and table sizes, for the evidence (FILESTORE_DESIGN.md section 5, --measure). */
export async function measure(db: Kysely<Database>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out.database = Number((await sql<{ n: string }>`SELECT pg_database_size(current_database()) AS n`.execute(db)).rows[0]?.n ?? 0);
  for (const t of ['canva_design_plans', 'canva_editable_sources', 'design_studio_candidates', 'task_events', 'outbox_commands', 'photo_cutouts', 'comparison_pairs']) {
    out[t] = Number((await sql<{ n: string }>`SELECT pg_total_relation_size(${`hawa.${t}`}::regclass) AS n`.execute(db)).rows[0]?.n ?? 0);
  }
  return out;
}

// ---- CLI ----

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const phaseArg = option(args, '--phase') ?? 'all';
  const mode = (option(args, '--mode') ?? '') as Mode;
  if (!['copy', 'verify', 'strip'].includes(mode)) throw new Error('--mode copy|verify|strip is required');
  const phases = phaseArg === 'all' ? PHASES : phaseArg.split(',').map((p) => {
    if (!(PHASES as readonly string[]).includes(p)) throw new Error(`Unknown phase ${p}`);
    return p as Phase;
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL (the owner connection) is required');
  const root = process.env.HAWA_BLOB_DIR;
  if (!root) throw new Error('HAWA_BLOB_DIR is required');
  // The target is checked on its address before any connection is made (strip, or production without
  // --production, never connects), and again on its name and migrations once connected.
  const production = args.includes('--production');
  if (isProductionTarget(databaseUrl) && (mode === 'strip' || !production)) assertTargetAllowed({ databaseUrl, mode, production });
  const db = createDb(databaseUrl);
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    process.stderr.write('Stopping after the row in hand…\n');
  });
  try {
    const database = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]?.d;
    const accept = option(args, '--accept-left-as-is');
    assertTargetAllowed({
      databaseUrl,
      database,
      mode,
      production,
      receiptPath: option(args, '--receipt'),
      migrations: await migrationChecksums(db).catch(() => ({})),
      ...(accept !== undefined ? { acceptLeftAsIs: Number(accept) } : {}),
    });
    const store = new BlobStore({ root: path.resolve(root), db });
    await assertPreconditions(db, store);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = option(args, '--log') ?? path.join(os.homedir(), `.hawa/logs/blob_backfill_${stamp}.ndjson`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = (line: Record<string, unknown>) => fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
    const before = args.includes('--measure') ? await measure(db) : undefined;
    const limit = option(args, '--limit');
    const reports = await runBackfill({
      db,
      store,
      phases,
      mode,
      batch: Number(option(args, '--batch') ?? 25),
      ...(limit ? { limit: Number(limit) } : {}),
      dryRun: args.includes('--dry-run'),
      log,
      shouldStop: () => stopping,
    });
    const after = before ? await measure(db) : undefined;
    let receipt: string | undefined;
    if (args.includes('--write-receipt')) {
      receipt = option(args, '--receipt') ?? path.join(os.homedir(), '.hawa/logs/blob_backfill_rehearsal.json');
      fs.mkdirSync(path.dirname(receipt), { recursive: true });
      fs.writeFileSync(receipt, `${JSON.stringify(rehearsalReceipt(String(database), await migrationChecksums(db), reports), null, 2)}\n`, { mode: 0o600 });
    }
    const summary = { database, mode, phases, reports, ...(before ? { measureBefore: before, measureAfter: after } : {}), ...(receipt ? { receipt } : {}), log: logFile };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    // 3: stopped (a signal or --limit) with work left, so run it again; 1: problems to read.
    if (reports.some((r) => r.stoppedEarly)) return 3;
    return reports.some((r) => r.problems.length) ? 1 : 0;
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(2);
    }
  );
}
