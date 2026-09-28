import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb } from '../src/client.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';

/** This file's scratch databases (hawa_verify_*, hawa_drill_*) end in it; files run in parallel. */
const scratchSuffix = `t${Math.random().toString(36).slice(2, 10)}`;

/**
 * The backups of the file store, end to end (ADR-035 section 2.6, FILESTORE_DESIGN.md sections 4 and
 * 7): infra/backup/nightly_backup.sh, infra/backup/restore_drill.sh and infra/ops/disk_cleanup.sh run
 * as they are, against this file's own test database on the test server (hawa-test-postgres, port
 * 55432) and temporary directories for everything else: HOME, the snapshots, the archive, the store and
 * the drill. The scripts' production defaults are never reached: every variable is set here, HOME
 * points at a temporary directory, and the test refuses to start unless the database is a per-file
 * clone on the test server.
 *
 * The runs share state in order: packs made by one night are what the next night and the drill read.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const appUrl = process.env.TEST_DATABASE_URL;
const PG_CONTAINER = 'hawa-test-postgres';
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';

const dockerOk = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', 'hawa_owner'], { encoding: 'utf8', timeout: 20_000 }).status === 0;
const toolsBuilt = fs.existsSync(path.join(repo, 'apps/core/dist/tools/blob-gc.js')) && fs.existsSync(path.join(repo, 'apps/core/dist/tools/blob-verify.js'));

describe.skipIf(!ownerUrl || !appUrl || !dockerOk || !toolsBuilt)('nightly backup, restore drill and disk cleanup with the file store', () => {
  const target = new URL(ownerUrl!);
  const database = target.pathname.slice(1);
  // Never anything but this file's clone on the test server.
  if (target.port !== '55432' || !/^hawa_t_[a-z0-9_]+$/.test(database)) throw new Error(`refusing to back up ${target.port}/${database}`);

  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-backup-'));
  const dirs = {
    home: path.join(t, 'home'),
    snapshots: path.join(t, 'snapshots'),
    archive: path.join(t, 'archive'),
    cleanupArchive: path.join(t, 'cleanup-archive'),
    blobs: path.join(t, 'blobs'),
    drill: path.join(t, 'drill'),
  };
  const keyfile = path.join(t, 'passphrase');
  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = createDb(appUrl!);
  const store = new BlobStore({ root: dirs.blobs, db: app });
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
  let task = '';

  /** The scripts' whole environment: nothing is inherited but PATH and Docker's own configuration. */
  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HAWA_SCRATCH_DB_SUFFIX: scratchSuffix,
      HOME: dirs.home,
      DOCKER_CONFIG: path.join(os.homedir(), '.docker'),
      HAWA_BACKUP_SNAPSHOT_DIR: dirs.snapshots,
      HAWA_BACKUP_ARCHIVE_DEST: dirs.archive,
      HAWA_BACKUP_ARCHIVE_DIR: dirs.cleanupArchive,
      HAWA_BACKUP_ARCHIVE_KEYFILE: keyfile,
      HAWA_BACKUP_ARCHIVE_KEEP: '14',
      HAWA_BLOB_GRACE_DAYS: '15',
      HAWA_BACKUP_PG_CONTAINER: PG_CONTAINER,
      HAWA_BACKUP_DB: database,
      HAWA_BACKUP_MIN_BYTES: '1000',
      HAWA_BACKUP_NOTIFY_ENV: path.join(t, 'no-such-env-file'),
      HAWA_BLOBS_DIR: dirs.blobs,
      // The collector runs on this host against the clone, as the application role, like `docker exec` in Core.
      HAWA_BLOB_GC_CMD: `node ${JSON.stringify(path.join(repo, 'apps/core/dist/tools/blob-gc.js'))}`,
      DATABASE_URL: appUrl!,
      HAWA_BLOB_DIR: dirs.blobs,
      HAWA_DRILL_DIR: dirs.drill,
      HAWA_DRILL_DATABASE_URL: ownerUrl!,
      ...extra,
    };
  }
  async function nextSecond(): Promise<void> {
    const now = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1000 - (now % 1000) + 20));
  }
  async function run(script: string, args: string[] = [], extra: Record<string, string> = {}) {
    await nextSecond();
    const res = spawnSync('bash', [path.join(repo, script), ...args], { cwd: repo, env: env(extra), encoding: 'utf8', timeout: 180_000 });
    return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
  }
  const log = () => fs.readFileSync(path.join(dirs.snapshots, 'backup.log'), 'utf8').trim().split('\n');
  const lastOk = () => log().filter((l) => / OK /.test(l)).pop() ?? '';
  const backupStatus = () => spawnSync('python3', [path.join(repo,'infra/backup/backup_status.py'),
    '--snapshots',dirs.snapshots], {env:env(),encoding:'utf8',timeout:10_000});
  const field = (line: string, name: string) => new RegExp(`${name}=(\\S+)`).exec(line)?.[1];
  const stampOf = (line: string) => / OK (\d{8}T\d{6}Z) /.exec(line)?.[1] ?? '';
  const index = () => fs.readFileSync(path.join(dirs.archive, 'blobs/index.tsv'), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const packs = () => fs.readdirSync(path.join(dirs.archive, 'blobs')).filter((n) => n.startsWith('blobpack_')).sort();
  const reference = (sha256: string) =>
    owner.query(`INSERT INTO hawa.task_files(tenant_id, task_id, sha256, role) VALUES ($1, $2, $3, 'reference_image')`, [TENANT, task, sha256]);
  const scratchDatabases = async () =>
    (await owner.query(`SELECT datname FROM pg_database WHERE datname LIKE 'hawa_verify_%' OR datname LIKE 'hawa_drill_%'`)).rows
      .map((r) => r.datname as string)
      .filter((name) => name.endsWith(`_${scratchSuffix}`));

  beforeAll(async () => {
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyfile, randomBytes(24).toString('hex'), { mode: 0o600 });
    await initBlobStoreDir(dirs.blobs);
    await owner.connect();
    task = randomUUID();
    await owner.query(`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES ($1, $2, $3, 'backup test')`, [task, TENANT, CLIENT]);
  });
  afterAll(async () => {
    await owner.end().catch(() => {});
    await app.destroy();
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('refuses an archive retention that is not shorter than the grace period', async () => {
    const r = await run('infra/backup/nightly_backup.sh', [], { HAWA_BACKUP_ARCHIVE_KEEP: '15' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/must be less than HAWA_BLOB_GRACE_DAYS \(15\)/);
    expect(fs.readdirSync(dirs.snapshots).filter((n) => n.endsWith('.dump'))).toEqual([]);
    expect(fs.existsSync(dirs.archive) ? fs.readdirSync(dirs.archive) : []).toEqual([]);
  }, 60_000);

  it('a first night packs every stored file, encrypted, after a verified dump, and checks the pack', async () => {
    const refs = [await store.put(png(), 'image/png'), await store.put(png(), 'image/png')];
    for (const ref of refs) await reference(ref.sha256);
    await store.put(png(), 'image/png'); // unreferenced: backed up all the same
    const r = await run('infra/backup/nightly_backup.sh');
    expect(r.out).toMatch(/✓ backup/);
    expect(r.code).toBe(0);
    expect(backupStatus().status).toBe(0);
    const line = lastOk();
    const stamp = stampOf(line);
    expect(field(line, 'blobs')).toBe('3');
    expect(field(line, 'new_blobs')).toBe('3');
    expect(field(line, 'blob_bytes')).toBe(String(3 * 2008));
    expect(field(line, 'gc_deleted')).toBe('0');
    expect(field(line, 'dump_s')).toMatch(/^\d+$/);
    expect(fs.existsSync(path.join(dirs.archive, `hawa_${stamp}.dump.enc`))).toBe(true);
    const manifest = fs.readFileSync(path.join(dirs.archive, `hawa_${stamp}.blobs`), 'utf8').trim().split('\n');
    expect(manifest).toHaveLength(3);
    for (const entry of manifest) expect(entry).toMatch(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(packs()).toEqual([`blobpack_${stamp}.tar.enc`]);
    expect(index().map(([p]) => p).sort()).toEqual([...manifest].sort());
    // The pack is encrypted: no PNG signature in it.
    const pack = fs.readFileSync(path.join(dirs.archive, 'blobs', packs()[0]));
    expect(pack.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(log().some((l) => / GC /.test(l) && /"deleted":0/.test(l))).toBe(true);
    // Nothing left behind: no scratch directory, no verification database.
    expect(fs.readdirSync(dirs.snapshots).filter((n) => n.startsWith('.work_'))).toEqual([]);
    expect(await scratchDatabases()).not.toContain(`hawa_verify_${stamp.toLowerCase()}_${scratchSuffix}`);
  }, 180_000);

  it('an active archive writer prevents another nightly backup or restore from touching its set', async () => {
    const before = fs.readdirSync(dirs.snapshots).filter(n => n.endsWith('.dump')).sort();
    const activeWork = path.join(dirs.snapshots,'.work_other_active_writer');
    fs.mkdirSync(activeWork); fs.writeFileSync(path.join(activeWork,'preserve'),'owned by the active writer');
    const old = new Date(Date.now()-3*3600*1000); fs.utimesSync(activeWork,old,old);
    const holder = spawn('python3', ['-c',
      "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.readline()",
      path.join(dirs.archive, '.restate-backup.lock')], {stdio:['pipe','pipe','pipe']});
    const exited = once(holder, 'exit');
    const timer = setTimeout(() => holder.kill('SIGKILL'), 15_000);
    try {
      const [ready] = await once(holder.stdout, 'data');
      expect(String(ready)).toContain('locked');
      for (const script of ['infra/backup/nightly_backup.sh','infra/backup/restore_drill.sh']) {
        const result = await run(script);
        expect(result.code).toBe(1);
        expect(result.out).toContain('lock is busy, invalid or unavailable');
      }
      expect(fs.readdirSync(dirs.snapshots).filter(n => n.endsWith('.dump')).sort()).toEqual(before);
      expect(fs.readFileSync(path.join(activeWork,'preserve'),'utf8')).toBe('owned by the active writer');
      expect(await scratchDatabases()).toEqual([]);
    } finally {
      holder.stdin.end('\n');
      await exited;
      clearTimeout(timer);
      fs.rmSync(activeWork,{recursive:true,force:true});
    }
  }, 30_000);

  it('a second night with nothing new writes no pack; a new file makes a pack of one', async () => {
    const r1 = await run('infra/backup/nightly_backup.sh');
    expect(r1.code).toBe(0);
    expect(field(lastOk(), 'new_blobs')).toBe('0');
    expect(packs()).toHaveLength(1);
    expect(fs.existsSync(path.join(dirs.archive, `hawa_${stampOf(lastOk())}.blobs`))).toBe(true);

    const added = await store.put(png(), 'image/png');
    const r2 = await run('infra/backup/nightly_backup.sh');
    expect(r2.code).toBe(0);
    const stamp = stampOf(lastOk());
    expect(field(lastOk(), 'new_blobs')).toBe('1');
    expect(field(lastOk(), 'blobs')).toBe('4');
    expect(packs()).toHaveLength(2);
    expect(index().filter(([, p]) => p === `blobpack_${stamp}.tar.enc`).map(([f]) => f)).toEqual([`sha256/${added.sha256.slice(0, 2)}/${added.sha256}.png`]);
  }, 180_000);

  it('refuses missing or corrupt retained packs before publishing a new night or collecting files', async () => {
    const first = path.join(dirs.archive, 'blobs', packs()[0]);
    const bytes = fs.readFileSync(first);
    for (const damage of ['missing', 'corrupt']) {
      const priorOk = lastOk();
      const priorDumps = fs.readdirSync(dirs.archive).filter(n => n.endsWith('.dump.enc')).sort();
      const priorGc = log().filter(line => / GC /.test(line)).length;
      if (damage === 'missing') fs.unlinkSync(first);
      else fs.writeFileSync(first, Buffer.from('corrupted encrypted archive'));
      try {
        const result = await run('infra/backup/nightly_backup.sh');
        expect(result.code, damage).toBe(1);
        expect(result.out).toMatch(/file archive verification failed/);
        expect(lastOk()).toBe(priorOk);
        const observed = backupStatus();
        expect(observed.status).toBe(1);
        expect(observed.stdout).toContain('latest nightly backup failed');
        expect(log().filter(line => / GC /.test(line))).toHaveLength(priorGc);
        expect(fs.readdirSync(dirs.archive).filter(n => n.endsWith('.dump.enc')).sort()).toEqual(priorDumps);
      } finally {
        fs.writeFileSync(first, bytes);
      }
    }
  }, 180_000);

  it('refuses an incomplete cloud transport before a dump or external command', async () => {
    const bin = path.join(t, 'fake-cloud-bin'); fs.mkdirSync(bin);
    const calls = path.join(t, 'cloud-called');
    fs.writeFileSync(path.join(bin, 'gsutil'), '#!/bin/sh\ntouch "$HAWA_TEST_CLOUD_CALLED"\nexit 1\n', {mode:0o700});
    const before = fs.readdirSync(dirs.snapshots).filter(n => n.endsWith('.dump')).sort();
    const result = await run('infra/backup/nightly_backup.sh', [], {
      HAWA_BACKUP_ARCHIVE_DEST:'gs://synthetic-backup-test/unconfigured',
      PATH:`${bin}:${process.env.PATH}`, HAWA_TEST_CLOUD_CALLED:calls,
    });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/gs:\/\/.*complete database and file recovery/);
    expect(fs.existsSync(calls)).toBe(false);
    expect(fs.readdirSync(dirs.snapshots).filter(n => n.endsWith('.dump')).sort()).toEqual(before);
  }, 180_000);

  it('a checksum command failure cannot publish a recovery set from two empty digests', async () => {
    const bin=path.join(t,'fake-hash-bin');fs.mkdirSync(bin);
    const flag=path.join(t,'hash-failure-started');
    const real=spawnSync('bash',['-c','command -v shasum'],{encoding:'utf8'}).stdout.trim();
    expect(real).toBeTruthy();
    fs.writeFileSync(path.join(bin,'shasum'), [
      '#!/usr/bin/env python3','import os,sys','from pathlib import Path',
      "flag=Path(os.environ['HAWA_TEST_HASH_FAILURE'])",
      "if flag.exists() or (len(sys.argv)>1 and Path(sys.argv[-1]).name=='manifest'):",
      ' flag.touch();sys.exit(2)',
      "real=os.environ['HAWA_TEST_REAL_SHASUM'];os.execv(real,[real,*sys.argv[1:]])",'',
    ].join('\n'),{mode:0o700});
    const before=fs.readdirSync(dirs.archive).sort();
    const previous=lastOk();
    const result=await run('infra/backup/nightly_backup.sh',[],{
      PATH:`${bin}:${process.env.PATH}`,HAWA_TEST_HASH_FAILURE:flag,HAWA_TEST_REAL_SHASUM:real,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('could not checksum the archive source');
    expect(lastOk()).toBe(previous);
    expect(fs.readdirSync(dirs.archive).sort()).toEqual(before);
    expect(backupStatus().status).toBe(1);
  },180_000);

  it('fails the night when the dump references a file that is not on disk', async () => {
    const lost = await store.put(png(), 'image/png');
    await reference(lost.sha256);
    const file = store.pathOf(lost);
    const bytes = fs.readFileSync(file);
    fs.unlinkSync(file);
    const r = await run('infra/backup/nightly_backup.sh');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/the dump references 1 blob\(s\) not on disk/);
    expect(log().pop()).toMatch(/FAIL .*references 1 blob/);
    // The dump itself was verified, so it is kept under its name (not .failed), but never archived.
    const failedStamp = /FAIL (\d{8}T\d{6}Z)/.exec(log().pop() ?? '')?.[1];
    expect(fs.existsSync(path.join(dirs.snapshots, `hawa_${failedStamp}.dump`))).toBe(true);
    expect(fs.existsSync(path.join(dirs.archive, `hawa_${failedStamp}.dump.enc`))).toBe(false);
    // Storing the file again repairs it, and the next night passes.
    await store.put(bytes, 'image/png');
    const again = await run('infra/backup/nightly_backup.sh');
    expect(again.code).toBe(0);
    expect(field(lastOk(), 'new_blobs')).toBe('1');
  }, 180_000);

  it('the restore drill restores the newest dump and its files and records missing=0', async () => {
    const r = await run('infra/backup/restore_drill.sh');
    expect(r.out).toMatch(/✓ restore drill: .* missing=0/);
    expect(r.code).toBe(0);
    const rows = (await owner.query(`SELECT status, evidence FROM hawa.backup_drills WHERE evidence->>'drill_type' = 'data_and_blobs' ORDER BY completed_at DESC LIMIT 1`)).rows;
    expect(rows[0].status).toBe('passed');
    expect(rows[0].evidence).toMatchObject({ drill_type: 'data_and_blobs', missing: 0, rows: 5, blobs_checked: 5 });
    expect(rows[0].evidence.dump).toMatch(/^hawa_\d{8}T\d{6}Z\.dump\.enc$/);
    expect(fs.readdirSync(dirs.drill)).toEqual([]);
    expect((await scratchDatabases()).filter((d) => d.startsWith('hawa_drill_'))).toEqual([]);
  }, 180_000);

  it('the opted-in drill refuses an unpaired dump even when a newer Restate manifest exists', async () => {
    const unrelated = path.join(dirs.archive, 'restate_20990101T000000Z.json');
    fs.writeFileSync(unrelated, '{}');
    try {
      const r = await run('infra/backup/restore_drill.sh', [], { HAWA_RESTATE_BACKUP_ENABLED: 'on' });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/selected dump has no same-night Restate pair/);
      const last = (await owner.query(`SELECT status, evidence FROM hawa.backup_drills WHERE evidence->>'drill_type' = 'data_and_blobs' ORDER BY completed_at DESC LIMIT 1`)).rows[0];
      expect(last.status).toBe('failed');
      expect(last.evidence.dump).toBe(`hawa_${stampOf(lastOk())}.dump.enc`);
      expect((await scratchDatabases()).filter((d) => d.startsWith('hawa_drill_'))).toEqual([]);
    } finally {
      fs.unlinkSync(unrelated);
    }
  }, 180_000);

  it('a failed Restate capture preserves the previous archived recovery set', async () => {
    const previous = fs.readdirSync(dirs.archive).filter((n) => n.endsWith('.dump.enc')).sort();
    expect(previous.length).toBeGreaterThan(1);
    const r = await run('infra/backup/nightly_backup.sh', [], {
      HAWA_RESTATE_BACKUP_ENABLED: 'on', HAWA_BACKUP_ARCHIVE_KEEP: '1',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Restate volume backup failed/);
    const after = fs.readdirSync(dirs.archive).filter((n) => n.endsWith('.dump.enc'));
    for (const dump of previous) {
      expect(after).toContain(dump);
      expect(fs.existsSync(path.join(dirs.archive, dump.replace('.dump.enc', '.blobs')))).toBe(true);
    }
  }, 180_000);

  it('the restore drill fails, and records the failure, when a pack it needs is gone', async () => {
    const aside = path.join(t, 'aside');
    fs.mkdirSync(aside);
    const first = packs()[0];
    fs.renameSync(path.join(dirs.archive, 'blobs', first), path.join(aside, first));
    try {
      const r = await run('infra/backup/restore_drill.sh');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(new RegExp(`pack ${first.replace(/\./g, '\\.')} is missing`));
      const last = (await owner.query(`SELECT status FROM hawa.backup_drills WHERE evidence->>'drill_type' = 'data_and_blobs' ORDER BY completed_at DESC LIMIT 1`)).rows[0];
      expect(last.status).toBe('failed');
      expect((await scratchDatabases()).filter((d) => d.startsWith('hawa_drill_'))).toEqual([]);
    } finally {
      fs.renameSync(path.join(aside, first), path.join(dirs.archive, 'blobs', first));
    }
  }, 180_000);

  it('pruning keeps every pack a kept manifest still lists, and removes the rest', async () => {
    // A file only the pack of one night holds, then deleted from the store (as the collector would):
    // once the manifests that list it are pruned, its pack goes too.
    const gone = await store.put(png(), 'image/png');
    const r1 = await run('infra/backup/nightly_backup.sh');
    expect(r1.code).toBe(0);
    const lonelyPack = `blobpack_${stampOf(lastOk())}.tar.enc`;
    expect(packs()).toContain(lonelyPack);
    await owner.query('DELETE FROM hawa.blobs WHERE sha256 = $1', [gone.sha256]);
    fs.unlinkSync(store.pathOf(gone));
    const before = packs();

    const r2 = await run('infra/backup/nightly_backup.sh', [], { HAWA_BACKUP_ARCHIVE_KEEP: '1' });
    expect(r2.code).toBe(0);
    const stamp = stampOf(lastOk());
    expect(fs.readdirSync(dirs.archive).filter((n) => n.endsWith('.blobs'))).toEqual([`hawa_${stamp}.blobs`]);
    expect(fs.readdirSync(dirs.archive).filter((n) => /\.dump(\.enc)?$/.test(n))).toEqual([`hawa_${stamp}.dump.enc`]);
    const kept = packs();
    expect(kept).not.toContain(lonelyPack);
    expect(kept).toEqual(before.filter((p) => p !== lonelyPack));
    // Every file the kept manifest lists is still in a kept pack.
    const manifest = fs.readFileSync(path.join(dirs.archive, `hawa_${stamp}.blobs`), 'utf8').trim().split('\n');
    const packed = new Map(index().map(([f, p]) => [f, p]));
    for (const entry of manifest) expect(kept).toContain(packed.get(entry));
    expect(index().every(([, p]) => kept.includes(p))).toBe(true);

    // And the drill still passes on what is left.
    const drill = await run('infra/backup/restore_drill.sh');
    expect(drill.code).toBe(0);
  }, 240_000);

  it('disk_cleanup never touches the store, its packs, index or manifests, and removes only their stale .part files', async () => {
    // Point the cleanup at the real archive this time, with everything in it long past every age limit.
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const archiveBlobs = path.join(dirs.archive, 'blobs');
    const stalePack = path.join(archiveBlobs, 'blobpack_20200101T000000Z.tar.enc.part');
    const freshPack = path.join(archiveBlobs, 'blobpack_20990101T000000Z.tar.enc.part');
    const staleTmp = path.join(dirs.blobs, 'tmp', `${'a'.repeat(64)}.x.part`);
    for (const f of [stalePack, staleTmp]) fs.writeFileSync(f, 'x');
    const listing = (d: string) => fs.readdirSync(d).sort();
    for (const d of [dirs.archive, archiveBlobs]) for (const n of fs.readdirSync(d)) fs.utimesSync(path.join(d, n), old, old);
    fs.utimesSync(staleTmp, old, old);
    fs.writeFileSync(freshPack, 'x');
    const storeFiles = spawnSync('find', [dirs.blobs, '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f && !f.endsWith('.part')).sort();
    const archiveBefore = listing(dirs.archive);
    const packsBefore = listing(archiveBlobs).filter((n) => !n.endsWith('.part'));

    const r = await run('infra/ops/disk_cleanup.sh', ['--backups'], { HAWA_BACKUP_ARCHIVE_DIR: dirs.archive });
    expect(r.code).toBe(0);
    expect(listing(dirs.archive)).toEqual(archiveBefore);
    expect(listing(archiveBlobs)).toEqual([...packsBefore, path.basename(freshPack)].sort());
    expect(fs.existsSync(stalePack)).toBe(false);
    expect(fs.existsSync(staleTmp)).toBe(false);
    const after = spawnSync('find', [dirs.blobs, '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f && !f.endsWith('.part')).sort();
    expect(after).toEqual(storeFiles);

    const report = await run('infra/ops/disk_cleanup.sh', ['--report'], { HAWA_BACKUP_ARCHIVE_DIR: dirs.archive });
    expect(report.out).toMatch(/^files \S+ .*blobs$/m);
    expect(report.out).toMatch(/file store packs/);
  }, 120_000);

  it('without a passphrase file the packs are plain tar files, and the drill reads them the same way', async () => {
    const plain = path.join(t, 'plain-archive');
    const r = await run('infra/backup/nightly_backup.sh', [], { HAWA_BACKUP_ARCHIVE_DEST: plain, HAWA_BACKUP_ARCHIVE_KEYFILE: '' });
    expect(r.code).toBe(0);
    const stamp = stampOf(lastOk());
    expect(fs.existsSync(path.join(plain, `hawa_${stamp}.dump`))).toBe(true);
    expect(fs.readdirSync(path.join(plain, 'blobs')).sort()).toEqual([`blobpack_${stamp}.tar`, 'index.tsv']);
    const listed = spawnSync('tar', ['-tf', path.join(plain, 'blobs', `blobpack_${stamp}.tar`)], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
    expect(listed).toEqual(fs.readFileSync(path.join(plain, `hawa_${stamp}.blobs`), 'utf8').trim().split('\n').sort());
    const drill = await run('infra/backup/restore_drill.sh', [], { HAWA_BACKUP_ARCHIVE_DEST: plain, HAWA_BACKUP_ARCHIVE_KEYFILE: '' });
    expect(drill.out).toMatch(/missing=0/);
    expect(drill.code).toBe(0);
  }, 180_000);

  it('keeps an existing paired recovery set when Restate opt-in is later off', async () => {
    const pairedDump = fs.readdirSync(dirs.archive).find((n) => /^hawa_\d{8}T\d{6}Z\.dump\.enc$/.test(n));
    expect(pairedDump).toBeDefined();
    const stamp = /^hawa_(\d{8}T\d{6}Z)\.dump\.enc$/.exec(pairedDump!)![1];
    const fixture = `import sys, json\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[4])\nfrom restate_nightly import manifest_mac, pair_inputs, publish_pair, sha256\narchive, key, stamp = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]\nmanifest = archive / f'restate_{stamp}.json'\nmanifest.with_suffix('.tar.enc').write_bytes(b'synthetic retention-only ciphertext')\nfacts = {'schemaVersion': 2, 'encrypted': True, 'nodeName': 'hawa-restate-prod-1', 'capturedAt': stamp, 'encryptedSha256': sha256(manifest.with_suffix('.tar.enc')), 'crossStoreAtomic': False}\nfacts['manifestMac'] = manifest_mac(facts, key)\nmanifest.write_text(json.dumps(facts))\npublish_pair(archive, stamp, pair_inputs(archive, stamp), manifest, key)\n`;
    const made = spawnSync('python3', ['-c', fixture, dirs.archive, keyfile, stamp, path.join(repo, 'infra/backup')], { encoding: 'utf8' });
    expect(made.status).toBe(0);
    const pair = path.join(dirs.archive, `hawa_${stamp}.restate.json`);
    expect(fs.existsSync(pair)).toBe(true);

    const r = await run('infra/backup/nightly_backup.sh', [], { HAWA_BACKUP_ARCHIVE_KEEP: '1' });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dirs.archive, pairedDump!))).toBe(true);
    expect(fs.existsSync(pair)).toBe(true);
    expect(fs.existsSync(path.join(dirs.archive, `hawa_${stampOf(lastOk())}.dump.enc`))).toBe(true);
    expect(log().some((line) => line.includes('RESTATE-RETENTION') && line.includes('"keepPaired"'))).toBe(true);

    const before = fs.readdirSync(dirs.archive).sort();
    const noKey = await run('infra/backup/nightly_backup.sh', [], {
      HAWA_BACKUP_ARCHIVE_KEEP: '1', HAWA_BACKUP_ARCHIVE_KEYFILE: '',
    });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toMatch(/paired recovery archive needs a readable nonempty key before any dump is copied/);
    expect(fs.readdirSync(dirs.archive).sort()).toEqual(before);
  }, 180_000);
});
