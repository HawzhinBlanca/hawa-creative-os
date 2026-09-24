import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb } from '../src/client.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';
import { verifyBlobStore } from '../src/blobs/verify.js';

/**
 * The store check (packages/db/src/blobs/verify.ts and apps/core/src/tools/blob-verify.ts): what the
 * weekly check and the restore drill rely on to find a row whose file is gone or changed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const cli = path.join(repo, 'apps/core/dist/tools/blob-verify.js');

describe.skipIf(!appUrl || !ownerUrl)('blob store check', () => {
  const app = createDb(appUrl!);
  const owner = new pg.Client({ connectionString: ownerUrl });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-verify-'));
  const store = new BlobStore({ root, db: app });
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(500)]);
  beforeAll(async () => {
    await initBlobStoreDir(root);
    await owner.connect();
  });
  afterAll(async () => {
    await app.destroy();
    await owner.end();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runCli = () => spawnSync('node', [cli, '--dir', root], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DATABASE_URL: appUrl! }, timeout: 60_000 });

  it('reports a clean store, then each kind of damage, as the application role', async () => {
    const good = await store.put(png(), 'image/png');
    const clean = await verifyBlobStore(app, root);
    expect(clean).toMatchObject({ missing: 0, corrupt: 0, referencedWithoutRow: 0 });
    expect(clean.checked).toBe(clean.rows);

    const gone = await store.put(png(), 'image/png');
    fs.unlinkSync(store.pathOf(gone));
    const changed = await store.put(png(), 'image/png');
    fs.chmodSync(store.pathOf(changed), 0o644);
    const bytes = fs.readFileSync(store.pathOf(changed));
    bytes[100] ^= 0xff;
    fs.writeFileSync(store.pathOf(changed), bytes);
    const orphan = randomBytes(32).toString('hex');
    fs.mkdirSync(path.join(root, 'sha256', orphan.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(root, 'sha256', orphan.slice(0, 2), `${orphan}.png`), png());

    const report = await verifyBlobStore(app, root);
    expect(report.problems).toEqual(expect.arrayContaining([
      { sha256: gone.sha256, problem: 'missing' },
      expect.objectContaining({ sha256: changed.sha256, problem: 'hash' }),
    ]));
    expect(report.problems.map((p) => p.sha256)).not.toContain(good.sha256);
    expect(report).toMatchObject({ missing: 1, corrupt: 1, orphanFiles: 1 });
    // Sizes only: the changed bytes pass, the missing file does not.
    expect(await verifyBlobStore(app, root, { hash: false })).toMatchObject({ missing: 1, corrupt: 0 });
  });

  it.skipIf(!fs.existsSync(cli))('the tool exits 1 on damage and 0 once it is repaired', async () => {
    const damaged = runCli();
    expect(damaged.status).toBe(1);
    const line = JSON.parse(damaged.stdout.trim().split('\n').pop()!);
    expect(line).toMatchObject({ missing: 1, corrupt: 1 });
    // Repair: the rows whose files are bad go (as the owner, like a restore would put things right).
    for (const p of line.problems as Array<{ sha256: string }>) await owner.query('DELETE FROM hawa.blobs WHERE sha256 = $1', [p.sha256]);
    const repaired = runCli();
    expect(repaired.stdout).toMatch(/"missing":0/);
    expect(repaired.status).toBe(0);
  });
});
