import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb } from '../src/client.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';
import { verifyBlobStore } from '../src/blobs/verify.js';

/** This file's scratch databases (hawa_verify_*, hawa_drill_*) end in it; files run in parallel. */
const scratchSuffix = `t${Math.random().toString(36).slice(2, 10)}`;

/**
 * The first release of the file store, before the copy backfill has run. The running Core already
 * writes hashes into columns hawa.blob_references reads (design_studio_candidates.preview_sha256,
 * canva_design_plans.source_sha256 and others) while the bytes still live in bytea beside them, with no
 * hawa.blobs row and no file. Until migration 020 adds the foreign keys, such a hash is not a file the
 * store owes: the nightly backup must still archive, and the store check (weekly verify and the monthly
 * drill) must not count it as missing. A hash that has a row still needs its file (blob-backup.test.ts,
 * blob-verify.test.ts).
 *
 * Runs the scripts against this file's own clone on the test server and temporary directories only.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const appUrl = process.env.TEST_DATABASE_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';
const PG_CONTAINER = 'hawa-test-postgres';
const verifyCli = path.join(repo, 'apps/core/dist/tools/blob-verify.js');

const dockerOk = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', 'hawa_owner'], { encoding: 'utf8', timeout: 20_000 }).status === 0;

describe.skipIf(!ownerUrl || !appUrl || !dockerOk || !fs.existsSync(verifyCli))('the file store before the backfill', () => {
  const target = new URL(ownerUrl!);
  const database = target.pathname.slice(1);
  if (target.port !== '55432' || !/^hawa_t_[a-z0-9_]+$/.test(database)) throw new Error(`refusing ${target.port}/${database}`);
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-prebackfill-'));
  const dirs = { home: path.join(t, 'home'), snapshots: path.join(t, 'snapshots'), archive: path.join(t, 'archive'), blobs: path.join(t, 'blobs'), drill: path.join(t, 'drill') };
  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = createDb(appUrl!);
  const store = new BlobStore({ root: dirs.blobs, db: app });
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
  let oldStyle = '';
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
      HAWA_SCRATCH_DB_SUFFIX: scratchSuffix,
    HOME: dirs.home,
    DOCKER_CONFIG: path.join(os.homedir(), '.docker'),
    HAWA_BACKUP_SNAPSHOT_DIR: dirs.snapshots,
    HAWA_BACKUP_ARCHIVE_DEST: dirs.archive,
    HAWA_BACKUP_ARCHIVE_DIR: dirs.archive,
    HAWA_BACKUP_ARCHIVE_KEYFILE: '',
    HAWA_BACKUP_ARCHIVE_KEEP: '14',
    HAWA_BLOB_GRACE_DAYS: '15',
    HAWA_BACKUP_PG_CONTAINER: PG_CONTAINER,
    HAWA_BACKUP_DB: database,
    HAWA_BACKUP_MIN_BYTES: '1000',
    HAWA_BACKUP_NOTIFY_ENV: path.join(t, 'none'),
    HAWA_BLOBS_DIR: dirs.blobs,
    HAWA_BLOB_GC: 'off',
    HAWA_DRILL_DIR: dirs.drill,
    HAWA_DRILL_DATABASE_URL: ownerUrl!,
    ...extra,
  });
  const run = (script: string, extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(repo, script)], { cwd: repo, env: env(extra), encoding: 'utf8', timeout: 180_000 });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  /** The drill rows recorded so far, newest first. */
  const drills = async () =>
    (await owner.query(`SELECT status, evidence FROM hawa.backup_drills WHERE evidence->>'drill_type' = 'data_and_blobs' ORDER BY completed_at DESC`)).rows;

  beforeAll(async () => {
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    await initBlobStoreDir(dirs.blobs);
    await owner.connect();
    const task = randomUUID();
    await owner.query(`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES ($1, $2, $3, 'prebackfill')`, [task, TENANT, CLIENT]);
    const ref = await store.put(png(), 'image/png');
    await owner.query(`INSERT INTO hawa.task_files(tenant_id, task_id, sha256, role) VALUES ($1, $2, $3, 'reference_image')`, [TENANT, task, ref.sha256]);
    // A candidate as the running Core writes it today: the hash and the bytes, both in the row.
    const bytes = png();
    oldStyle = createHash('sha256').update(bytes).digest('hex');
    const run = randomUUID();
    await owner.query(
      `INSERT INTO hawa.design_studio_runs(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
       VALUES ($1, $2, $3, $4, 'actor', 'k', 'h', '{}', 'standard', 'awaiting_selection')`,
      [run, TENANT, task, CLIENT],
    );
    await owner.query(
      `INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, preview_sha256, preview_png)
       VALUES ($1, $2, $3, 1, '{}', 'draft', $4, $5)`,
      [randomUUID(), run, TENANT, oldStyle, bytes],
    );
  });
  afterAll(async () => {
    await owner.end().catch(() => {});
    await app.destroy();
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('the store check counts the old-style reference apart, not as missing', async () => {
    const report = await verifyBlobStore(app, dirs.blobs);
    expect(report).toMatchObject({ rows: 1, checked: 1, missing: 0, corrupt: 0, referencedWithoutRow: 1 });
    expect(report.problems).toEqual([{ sha256: oldStyle, problem: 'referenced_without_row', detail: 'and no file' }]);
    const cli = spawnSync('node', [verifyCli, '--dir', dirs.blobs], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DATABASE_URL: appUrl! }, timeout: 60_000 });
    expect(cli.stdout).toMatch(/"missing":0/);
    expect(cli.status).toBe(0);
  });

  it('the nightly backup still archives the dump and the stored files', () => {
    const r = run('infra/backup/nightly_backup.sh');
    expect(r.out).not.toMatch(/references \d+ blob\(s\) not on disk/);
    expect(r.code).toBe(0);
    const names = fs.readdirSync(dirs.archive);
    expect(names.some((n) => /^hawa_.*\.dump$/.test(n))).toBe(true);
    expect(names.some((n) => /^hawa_.*\.blobs$/.test(n))).toBe(true);
    const ok = fs.readFileSync(path.join(dirs.snapshots, 'backup.log'), 'utf8').trim().split('\n').pop() ?? '';
    // The old-style references are counted in the log line, so the backfill's progress is visible.
    expect(ok).toMatch(/ OK .* blobs=1 .*refs_without_row=1/);
  }, 180_000);

  it('the monthly restore drill passes on that archive', async () => {
    const r = run('infra/backup/restore_drill.sh');
    expect(r.out).toMatch(/✓ restore drill: .* missing=0/);
    expect(r.code).toBe(0);
    const rows = await drills();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('passed');
    expect(rows[0].evidence).toMatchObject({ missing: 0, rows: 1, referenced_without_row: 1 });
  }, 180_000);

  it('a drill that fails records one row and says why, whether the store check or a pack fails', async () => {
    const packDir = path.join(dirs.archive, 'blobs');
    const pack = fs.readdirSync(packDir).find((n) => /^blobpack_.*\.tar$/.test(n))!;
    const original = fs.readFileSync(path.join(packDir, pack));
    const index = fs.readFileSync(path.join(packDir, 'index.tsv'), 'utf8');
    try {
      // 1. A file in the pack with other bytes under its name: the store check reports it (exit 1).
      const x = path.join(t, 'repack');
      fs.mkdirSync(x);
      expect(spawnSync('tar', ['-xf', path.join(packDir, pack), '-C', x]).status).toBe(0);
      const inside = spawnSync('find', ['sha256', '-type', 'f'], { cwd: x, encoding: 'utf8' }).stdout.trim().split('\n');
      const bytes = fs.readFileSync(path.join(x, inside[0]));
      bytes[100] ^= 0xff;
      fs.chmodSync(path.join(x, inside[0]), 0o644);
      fs.writeFileSync(path.join(x, inside[0]), bytes);
      expect(spawnSync('tar', ['-cf', path.join(packDir, pack), ...inside], { cwd: x, env: { ...process.env, COPYFILE_DISABLE: '1' } }).status).toBe(0);
      const before = (await drills()).length;
      const corrupt = run('infra/backup/restore_drill.sh');
      expect(corrupt.code).toBe(1);
      expect(corrupt.out).toMatch(/the store check found missing=0 corrupt=1/);
      expect(corrupt.out).not.toMatch(/stopped unexpectedly/);
      const afterCorrupt = await drills();
      expect(afterCorrupt).toHaveLength(before + 1);
      expect(afterCorrupt[0]).toMatchObject({ status: 'failed', evidence: { missing: 0, referenced_without_row: 1 } });

      // 2. A pack named .enc with no readable passphrase: the unpack fails, once.
      fs.writeFileSync(path.join(packDir, pack), original);
      fs.renameSync(path.join(packDir, pack), path.join(packDir, `${pack}.enc`));
      fs.writeFileSync(path.join(packDir, 'index.tsv'), index.replaceAll(`\t${pack}\n`, `\t${pack}.enc\n`));
      const locked = run('infra/backup/restore_drill.sh');
      expect(locked.code).toBe(1);
      expect(locked.out).toMatch(new RegExp(`pack ${pack.replace('.', '\\.')}\\.enc does not decrypt and unpack`));
      expect(locked.out.match(/DRILL FAIL/g)).toHaveLength(1);
      const afterLocked = await drills();
      expect(afterLocked).toHaveLength(before + 2);
      expect(afterLocked[0].status).toBe('failed');
    } finally {
      fs.rmSync(path.join(packDir, `${pack}.enc`), { force: true });
      fs.writeFileSync(path.join(packDir, pack), original);
      fs.writeFileSync(path.join(packDir, 'index.tsv'), index);
    }
    // Put back as it was, the drill passes again.
    expect(run('infra/backup/restore_drill.sh').code).toBe(0);
  }, 300_000);

  it('a collector failure is logged once and alerts as a clean-up failure; the night still passes', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100)); // a new second, so a new dump name
    const r = run('infra/backup/nightly_backup.sh', { HAWA_BLOB_GC: 'on', HAWA_BLOB_GC_CMD: `sh -c 'echo collector broke >&2; exit 3' gc` });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/stopped unexpectedly/);
    const lines = fs.readFileSync(path.join(dirs.snapshots, 'backup.log'), 'utf8').trim().split('\n');
    const stamp = / OK (\d{8}T\d{6}Z) /.exec(lines[lines.length - 1])?.[1];
    expect(lines[lines.length - 1]).toMatch(/ gc_deleted=failed( |$)/);
    expect(lines.filter((l) => l.includes(`${stamp}`) && / FAIL /.test(l))).toEqual([]);
    expect(lines.filter((l) => l.includes(`GC-FAIL ${stamp}: collector broke`))).toHaveLength(1);
  }, 180_000);

  it('with a gs:// destination, where the files are not archived, the collector does not run', async () => {
    // gsutil is stubbed first on PATH: nothing leaves this machine, and the stub records that it ran.
    const bin = path.join(t, 'bin');
    const calls = path.join(t, 'calls');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gsutil'), `#!/bin/sh\necho "gsutil $*" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
    await new Promise((resolve) => setTimeout(resolve, 1100)); // a new second, so a new dump name
    const r = run('infra/backup/nightly_backup.sh', {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HAWA_BACKUP_ARCHIVE_DEST: 'gs://hawa-test-no-such-bucket/backups',
      HAWA_BLOB_GC: 'on',
      HAWA_BLOB_GC_CMD: `sh -c 'echo ran >> ${JSON.stringify(calls).slice(1, -1)}' gc`,
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/the file store is not archived to a gs:\/\/ destination/);
    expect(r.out).toMatch(/the file store collector did not run/);
    const recorded = fs.readFileSync(calls, 'utf8');
    expect(recorded).toMatch(/^gsutil cp /m);
    expect(recorded).not.toMatch(/^ran$/m);
    const ok = fs.readFileSync(path.join(dirs.snapshots, 'backup.log'), 'utf8').trim().split('\n').pop() ?? '';
    expect(ok).toMatch(/ OK .* gc_deleted=skipped_unarchived( |$)/);
  }, 180_000);
});
