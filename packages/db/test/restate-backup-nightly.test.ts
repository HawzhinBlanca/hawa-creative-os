import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** This file's scratch databases (hawa_verify_*) end in it; files run in parallel. */
const scratchSuffix = `r${Math.random().toString(36).slice(2, 10)}`;

/**
 * The nightly job's Restate step (architecture programme 2.6, ADR-034): infra/backup/nightly_backup.sh
 * runs infra/backup/restate-nightly.sh first when HAWA_RESTATE_BACKUP=on, never when it is off (the
 * default), hands it the night's stamp and archive settings, records its result and duration in the
 * nightly log line, and fails the night when it failed, after the dump is safely taken.
 *
 * The whole nightly script runs against this file's own test database on the test server (as
 * blob-backup.test.ts does); the Restate step is replaced through HAWA_RESTATE_BACKUP_CMD by a stub
 * that records what it was given. The script's control flow itself is packages/testkit/test/restate-nightly.test.ts.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const PG_CONTAINER = 'hawa-test-postgres';
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';

const dockerOk = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', 'hawa_owner'], { encoding: 'utf8', timeout: 20_000 }).status === 0;

describe.skipIf(!ownerUrl || !dockerOk)('the nightly job runs the Restate backup behind HAWA_RESTATE_BACKUP', () => {
  const target = new URL(ownerUrl!);
  const database = target.pathname.slice(1);
  // Never anything but this file's clone on the test server.
  if (target.port !== '55432' || !/^hawa_t_[a-z0-9_]+$/.test(database)) throw new Error(`refusing to back up ${target.port}/${database}`);

  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-restate-nightly-wiring-'));
  const dirs = { home: path.join(t, 'home'), snapshots: path.join(t, 'snapshots'), archive: path.join(t, 'archive'), blobs: path.join(t, 'blobs') };
  const keyfile = path.join(t, 'passphrase');
  const record = path.join(t, 'restate-step');
  const owner = new pg.Client({ connectionString: ownerUrl });

  // The stub Restate step: what it was handed, and whether the night's dump existed when it ran.
  const stub = path.join(t, 'restate-stub.sh');
  fs.writeFileSync(stub, [
    '#!/bin/bash',
    `{ echo "stamp=$HAWA_BACKUP_STAMP"; echo "dir=$HAWA_BACKUP_SNAPSHOT_DIR"; echo "dest=$HAWA_BACKUP_ARCHIVE_DEST"; echo "keep=$HAWA_BACKUP_ARCHIVE_KEEP"; echo "keyfile=$HAWA_BACKUP_ARCHIVE_KEYFILE";`,
    '  if ls "$HAWA_BACKUP_SNAPSHOT_DIR"/hawa_"$HAWA_BACKUP_STAMP".dump >/dev/null 2>&1; then echo "dump_before=yes"; else echo "dump_before=no"; fi; } > "$1"',
    'exit "${STUB_EXIT:-0}"',
  ].join('\n'), { mode: 0o755 });

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HAWA_SCRATCH_DB_SUFFIX: scratchSuffix,
      HOME: dirs.home,
      DOCKER_CONFIG: path.join(os.homedir(), '.docker'),
      HAWA_BACKUP_SNAPSHOT_DIR: dirs.snapshots,
      HAWA_BACKUP_ARCHIVE_DEST: dirs.archive,
      HAWA_BACKUP_ARCHIVE_DIR: path.join(t, 'cleanup-archive'),
      HAWA_BACKUP_ARCHIVE_KEYFILE: keyfile,
      HAWA_BACKUP_ARCHIVE_KEEP: '14',
      HAWA_BLOB_GRACE_DAYS: '15',
      HAWA_BACKUP_PG_CONTAINER: PG_CONTAINER,
      HAWA_BACKUP_DB: database,
      HAWA_BACKUP_MIN_BYTES: '1000',
      HAWA_BACKUP_NOTIFY_ENV: path.join(t, 'no-such-env-file'),
      HAWA_BLOBS_DIR: dirs.blobs,
      HAWA_BLOB_GC: 'off',
      HAWA_RESTATE_BACKUP_CMD: `bash ${JSON.stringify(stub)} ${JSON.stringify(record)}`,
      ...extra,
    };
  }
  async function run(extra: Record<string, string> = {}) {
    // One run per second at most: the stamp names the files.
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 20));
    fs.rmSync(record, { force: true });
    const res = spawnSync('bash', [path.join(repo, 'infra/backup/nightly_backup.sh')], { cwd: repo, env: env(extra), encoding: 'utf8', timeout: 180_000 });
    return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
  }
  const log = () => fs.readFileSync(path.join(dirs.snapshots, 'backup.log'), 'utf8').trim().split('\n');
  const lastOk = () => log().filter((l) => / OK \d{8}T/.test(l)).pop() ?? '';
  const stampOf = (line: string) => / OK (\d{8}T\d{6}Z) /.exec(line)?.[1] ?? '';
  const recorded = () => Object.fromEntries(fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  beforeAll(async () => {
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyfile, randomBytes(24).toString('hex'), { mode: 0o600 });
    await owner.connect();
    await owner.query(`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES ($1, $2, $3, 'restate backup wiring')`, [randomUUID(), TENANT, CLIENT]);
  });
  afterAll(async () => {
    await owner.end().catch(() => {});
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('off by default: the Restate step does not run and the log says restate=off', async () => {
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(fs.existsSync(record)).toBe(false);
    expect(lastOk()).toMatch(/ restate=off restate_s=0$/);
  });

  it('on: runs first, with the night\'s stamp and archive settings, and records its result and duration', async () => {
    const r = await run({ HAWA_RESTATE_BACKUP: 'on' });
    expect(r.code, r.out).toBe(0);
    const line = lastOk();
    expect(line).toMatch(/ restate=ok restate_s=\d+$/);
    const got = recorded();
    expect(got).toEqual({
      stamp: stampOf(line), dir: dirs.snapshots, dest: dirs.archive, keep: '14', keyfile,
      // Before the dump: a restore of both finds Postgres at or ahead of Restate.
      dump_before: 'no',
    });
  });

  it('a failed Restate step still leaves a verified, archived dump, then fails the night', async () => {
    const r = await run({ HAWA_RESTATE_BACKUP: 'on', STUB_EXIT: '3' });
    expect(r.code).toBe(1);
    const line = lastOk();
    expect(line).toMatch(/ restate=failed /);
    const stamp = stampOf(line);
    expect(fs.existsSync(path.join(dirs.snapshots, `hawa_${stamp}.dump`))).toBe(true);
    expect(fs.existsSync(path.join(dirs.snapshots, `hawa_${stamp}.dump.failed`))).toBe(false);
    expect(fs.existsSync(path.join(dirs.archive, `hawa_${stamp}.dump.enc`))).toBe(true);
    expect(log().pop()).toMatch(new RegExp(`FAIL ${stamp}: the Restate backup failed`));
  });
});
