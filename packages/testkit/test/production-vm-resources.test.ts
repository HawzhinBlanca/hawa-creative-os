import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production's Postgres crashed twice in 48 hours (2026-09-29 09:11, 2026-09-30 07:26) while the Docker
 * VM it shares with the test and chaos stacks swapped 14.5 of 15 GB (audit 2026-09-30 #1, ADR-158).
 *
 * - Production Postgres syncs its data directory with syncfs in crash recovery (file by file took over
 *   a minute while every client was refused) and has a memory reservation.
 * - The test Postgres and every chaos service have a memory ceiling without swap beyond it, and a CPU
 *   share, so they cannot push production's containers out.
 *
 * Read with `docker compose config`, the way compose itself resolves the files.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });

type Service = { command?: string[]; mem_limit?: unknown; memswap_limit?: unknown; mem_reservation?: unknown; cpus?: unknown; profiles?: string[] };
function config(files: string[], env: Record<string, string>, profiles: string[] = []): Record<string, Service> {
  const res = spawnSync('docker', ['compose', ...files.flatMap((f) => ['-f', f]), ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir(), ...env },
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout).services;
}

describe.skipIf(compose.status !== 0)('the Docker VM production shares', () => {
  it('production Postgres: syncfs crash recovery and a memory reservation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-vm-'));
    for (const f of ['docker-compose.prod.yml', 'canva-release.override.yml']) fs.copyFileSync(path.join(repo, 'infra/docker', f), path.join(dir, f));
    for (const file of ['.env.production', '.env.worker', '.env.service-boundaries']) fs.writeFileSync(path.join(dir, file), '');
    try {
      const pg = config([path.join(dir, 'docker-compose.prod.yml')], { DATABASE_URL: 'postgresql://x', POSTGRES_PASSWORD: 'x' }).postgres;
      expect(pg.command).toEqual(expect.arrayContaining(['recovery_init_sync_method=syncfs']));
      expect(Number(pg.mem_reservation)).toBe(1024 ** 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the test Postgres has a memory ceiling without swap and a CPU share', () => {
    const pg = config([path.join(repo, 'infra/docker/docker-compose.test.yml')], { HAWA_TEST_POSTGRES_PASSWORD: 'x' }).postgres;
    expect(Number(pg.mem_limit)).toBe(2 * 1024 ** 3);
    expect(pg.memswap_limit).toEqual(pg.mem_limit);
    expect(Number(pg.cpus)).toBe(3);
  });

  it('every chaos service, in every profile, has a memory ceiling without swap and a CPU share', () => {
    const secrets = ['CHAOS_APP_PASSWORD', 'CHAOS_WORKER_TOKEN', 'CHAOS_DESIGN_WORKER_TOKEN', 'CHAOS_BEARER_TOKEN', 'CHAOS_REVIEWER_KEY', 'CHAOS_ADMIN_KEY', 'CHAOS_HMAC_SECRET',
      'CHAOS_BOT_TOKEN', 'CHAOS_WEBHOOK_SECRET', 'CHAOS_CANVA_SECRET', 'CHAOS_CANVA_KEY', 'CHAOS_OWNER_PASSWORD', 'CHAOS_AVAILABILITY_SECRET'];
    const services = config([path.join(repo, 'packages/testkit/chaos/docker-compose.chaos.yml')], Object.fromEntries(secrets.map((k) => [k, 'x'])), ['green', 'candidate']);
    expect(Object.keys(services).length).toBeGreaterThanOrEqual(10);
    for (const [name, s] of Object.entries(services)) {
      expect(Number(s.mem_limit), name).toBeGreaterThan(0);
      expect(s.memswap_limit, name).toEqual(s.mem_limit);
      expect(Number(s.cpus), name).toBeGreaterThan(0);
    }
  });
});
