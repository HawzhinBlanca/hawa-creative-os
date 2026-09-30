import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, openSync, closeSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const syntheticDatabase = 'postgresql://hawa_app:' + 'synthetic_core_password@postgres:5432/hawa';

it('excludes planted Core secrets, preserves service identity, and regenerates worker config on rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hawa-service-boundary-'));
  const run = () => spawnSync('python3', [resolve('infra/ops/prepare_service_boundaries.py'), '--directory', directory], { encoding:'utf8' });
  try {
    const source = 'TELEGRAM_BOT_TOKEN=synthetic_bot\nHAWA_WORKER_TOKEN=synthetic_internal\nOPENAI_API_KEY=must_never_reach_worker\nCANVA_CLIENT_SECRET=must_never_reach_worker\nHAWA_BEARER_TOKEN=synthetic_legacy_operator_key_to_scope_12345\nHAWA_ADMIN_KEY=must_never_reach_worker\nDATABASE_URL=' + syntheticDatabase + '\n';
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
    expect(worker).not.toContain('synthetic_legacy_operator_key_to_scope_12345');
    expect(worker).toContain('DATABASE_URL=postgresql://hawa_worker_login:');
    expect(worker).not.toContain('synthetic_core_password');
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

it('host office preflight reads the same generated proof as Core and still refuses missing, colliding or duplicate fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hawa-office-preflight-'));
  const source = join(directory, '.env.production');
  const boundary = join(directory, '.env.service-boundaries');
  const proof = 'a'.repeat(64);
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/check_office_access.ts'), source, '127.0.0.1'], { encoding: 'utf8' });
  try {
    writeFileSync(source, 'HAWA_DESK_AUTH_MODE=trusted_office\nHAWA_TRUSTED_OFFICE_ORIGIN=http://127.0.0.1:8080\n');
    expect(run().status).not.toBe(0);
    writeFileSync(boundary, `HAWA_OFFICE_PROXY_PROOF=${proof}\n`);
    const valid = run();
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).not.toContain(proof);
    writeFileSync(source, readFileSync(source, 'utf8') + `HAWA_BEARER_TOKEN=${proof}\n`);
    expect(run().status).not.toBe(0);
    writeFileSync(source, 'HAWA_DESK_AUTH_MODE=required\nHAWA_DESK_AUTH_MODE=trusted_office\n');
    expect(run().status).not.toBe(0);
    writeFileSync(source, 'HAWA_DESK_AUTH_MODE=required\n');
    rmSync(boundary);
    expect(run().status).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it('preserves the bound proof inode and an open reader across a changed proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hawa-bound-proof-'));
  const run = () => spawnSync('python3', [resolve('infra/ops/prepare_service_boundaries.py'), '--directory', directory], {encoding:'utf8'});
  let fd: number | undefined;
  try {
    writeFileSync(join(directory,'.env.production'),'DATABASE_URL=' + syntheticDatabase + '\n');
    expect(run().status).toBe(0);
    const file=join(directory,'.office-proxy-header.conf'), inode=statSync(file).ino;
    fd=openSync(file,'r');
    const boundary=join(directory,'.env.service-boundaries');
    writeFileSync(boundary,readFileSync(boundary,'utf8').replace(/HAWA_OFFICE_PROXY_PROOF=[a-f0-9]+/, 'HAWA_OFFICE_PROXY_PROOF='+ 'b'.repeat(64)));
    expect(run().status).toBe(0);
    expect(statSync(file).ino).toBe(inode);
    const bytes=Buffer.alloc(200), length=readSync(fd,bytes,0,200,0);
    expect(bytes.subarray(0,length).toString()).toContain('b'.repeat(64));
  } finally { if(fd!==undefined) closeSync(fd); rmSync(directory,{recursive:true,force:true}); }
});

it('rotates legacy shared aliases with a scoped drain token, and retries without rotating again', () => {
  const directory=mkdtempSync(join(tmpdir(),'hawa-worker-rotate-'));
  const old='synthetic_legacy_shared_worker_operator_value_1234';
  const run=(rotate=false) => spawnSync('python3',[resolve('infra/ops/prepare_service_boundaries.py'),'--directory',directory,...(rotate?['--rotate-design']:[])],{encoding:'utf8'});
  try {
    writeFileSync(join(directory,'.env.production'),`# retained\nDATABASE_URL=${syntheticDatabase}\nHAWA_BEARER_TOKEN=${old}\nHAWA_API_KEY=${old}\nHAWA_DESK_SECRET=${old}\n`);
    writeFileSync(join(directory,'.env.service-boundaries'),`HAWA_OFFICE_PROXY_PROOF=${'a'.repeat(64)}\nHAWA_DESIGN_WORKER_TOKEN=${old}\n`);
    expect(run().status).toBe(0); // Preflight leaves running identities alone.
    expect(readFileSync(join(directory,'.env.production'),'utf8')).toContain(old);
    expect(run(true).status).toBe(0);
    const boundary=readFileSync(join(directory,'.env.service-boundaries'),'utf8');
    expect(boundary).toContain('HAWA_DESIGN_WORKER_TOKEN_PREVIOUS='+old);
    const worker=readFileSync(join(directory,'.env.worker'),'utf8');
    expect(worker).not.toContain(old);
    expect(worker).not.toContain('TOKEN_PREVIOUS=');
    const source=readFileSync(join(directory,'.env.production'),'utf8');
    expect(source).not.toContain(old);
    expect(source).toContain('# retained');
    const aliases=source.split('\n').filter(line=>/^HAWA_(BEARER_TOKEN|API_KEY|DESK_SECRET)=/.test(line)).map(line=>line.split('=')[1]);
    expect(new Set(aliases).size).toBe(1);
    expect(boundary).not.toContain('HAWA_DESIGN_WORKER_TOKEN='+aliases[0]);
    expect(run(true).status).toBe(0);
    expect(readFileSync(join(directory,'.env.service-boundaries'),'utf8')).toBe(boundary);
  } finally {rmSync(directory,{recursive:true,force:true});}
});


it('uses Compose DATABASE_URL precedence and an independent password, never the stale provider-file URL',()=>{
  const directory=mkdtempSync(join(tmpdir(),'hawa-worker-db-precedence-'));
  const composeUrl='postgresql://hawa_app_a:'+'synthetic_compose_password@postgres:5432/hawa?sslmode=disable';
  try {
    writeFileSync(join(directory,'.env.production'),'DATABASE_URL='+syntheticDatabase+'\n');
    writeFileSync(join(directory,'.env'),'DATABASE_URL='+composeUrl+'\n');
    const result=spawnSync('python3',[resolve('infra/ops/prepare_service_boundaries.py'),'--directory',directory],{encoding:'utf8'});
    expect(result.status,result.stderr).toBe(0);
    const worker=readFileSync(join(directory,'.env.worker'),'utf8');
    expect(worker).toContain('@postgres:5432/hawa?sslmode=disable');
    expect(worker).not.toContain('synthetic_compose_password');
    expect(worker).not.toContain('synthetic_core_password');
    writeFileSync(join(directory,'.env.production'),'TELEGRAM_BOT_TOKEN=synthetic\n');
    expect(spawnSync('python3',[resolve('infra/ops/prepare_service_boundaries.py'),'--directory',directory],{encoding:'utf8'}).status).toBe(0);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
