import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('excludes planted Core secrets, preserves service identity, and regenerates worker config on rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hawa-service-boundary-'));
  const run = () => spawnSync('python3', [resolve('infra/ops/prepare_service_boundaries.py'), '--directory', directory], { encoding:'utf8' });
  try {
    const source = 'TELEGRAM_BOT_TOKEN=synthetic_bot\nHAWA_WORKER_TOKEN=synthetic_internal\nOPENAI_API_KEY=must_never_reach_worker\nCANVA_CLIENT_SECRET=must_never_reach_worker\nHAWA_BEARER_TOKEN=synthetic_legacy_operator_key_to_scope_12345\nHAWA_ADMIN_KEY=must_never_reach_worker\n';
    writeFileSync(join(directory,'.env.production'),source);
    expect(run().status).toBe(0);
    const boundary = readFileSync(join(directory,'.env.service-boundaries'),'utf8');
    const worker = readFileSync(join(directory,'.env.worker'),'utf8');
    expect(worker).toContain('TELEGRAM_BOT_TOKEN=synthetic_bot');
    expect(worker).toContain('HAWA_WORKER_TOKEN=synthetic_internal');
    expect(worker).toContain('HAWA_DESIGN_WORKER_TOKEN=');
    expect(worker).not.toContain('must_never_reach_worker');
    expect(worker).not.toContain('HAWA_OFFICE_PROXY_PROOF');
    expect(worker).not.toContain('HAWA_BEARER_TOKEN=');
    expect(worker).toContain('HAWA_DESIGN_WORKER_TOKEN=synthetic_legacy_operator_key_to_scope_12345');
    const proof = boundary.split('\n').find(line=>line.startsWith('HAWA_OFFICE_PROXY_PROOF='))!.split('=')[1];
    expect(readFileSync(join(directory,'.office-proxy-header.conf'),'utf8')).toContain(`X-Hawa-Office-Proof "${proof}"`);
    for (const file of ['.env.worker','.env.service-boundaries','.office-proxy-header.conf'])
      expect(statSync(join(directory,file)).mode & 0o777).toBe(0o600);
    writeFileSync(join(directory,'.env.production'),source.replace('synthetic_bot','rotated_bot'));
    const repeated = run();
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).not.toContain(proof);
    const nextBoundary = readFileSync(join(directory,'.env.service-boundaries'),'utf8');
    expect(nextBoundary.split('\n').slice(0,2)).toEqual(boundary.split('\n').slice(0,2));
    expect(nextBoundary).not.toBe(boundary);
    const revision = nextBoundary.split('\n').find(line=>line.startsWith('HAWA_CONFIGURATION_REVISION='))!;
    expect(readFileSync(join(directory,'.env.worker'),'utf8')).toContain(revision);
    expect(readFileSync(join(directory,'.env.worker'),'utf8')).toContain('rotated_bot');
    writeFileSync(join(directory,'.env.service-boundaries'),'HAWA_OFFICE_PROXY_PROOF=broken\n');
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(directory,'.env.worker'),'utf8')).toContain('rotated_bot');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

it('overwrites caller proof in every nginx Core proxy location and keeps Desk free of the secret', () => {
  const nginx = readFileSync(resolve('infra/docker/nginx.conf'),'utf8');
  const coreLocations = nginx.split(/location\s/).filter(section=>section.includes('proxy_pass http://core_api;'));
  expect(coreLocations.length).toBeGreaterThan(0);
  for (const location of coreLocations) expect(location).toContain('include /etc/nginx/hawa-office-proof.conf;');
  const compose = readFileSync(resolve('infra/docker/docker-compose.prod.yml'),'utf8');
  expect(compose.slice(compose.indexOf('x-worker:'),compose.indexOf('services:'))).not.toContain('- .env.production');
});
