import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeOfficeProofInclude } from '../chaos/driver/office-proof.js';
import { configureStack, compose, envFile, officeProofFile, REPO_ROOT } from '../chaos/driver/stack.js';

const dir = mkdtempSync(join(tmpdir(), 'hawa-chaos-boundaries-'));
afterAll(async () => {
  await configureStack({ project: 'hawa-chaos' });
  rmSync(dir, { recursive: true, force: true });
});

describe('disposable candidate service boundaries (ADR205)', () => {
  it('preserves the mounted inode and private permissions across proof updates', () => {
    const path = join(dir, 'proof.conf');
    writeOfficeProofInclude(path, 'a'.repeat(64));
    const inode = statSync(path).ino;
    writeOfficeProofInclude(path, 'b'.repeat(64));
    expect(statSync(path).ino === inode).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8') === `proxy_set_header X-Hawa-Office-Proof "${'b'.repeat(64)}";\n`).toBe(true);
  });

  it('refuses invalid proof content before touching a prior include', () => {
    const path = join(dir, 'invalid.conf');
    writeOfficeProofInclude(path, 'c'.repeat(64));
    const before = readFileSync(path);
    for (const proof of ['', 'short', 'A'.repeat(64), `${'d'.repeat(64)}"; include /tmp/other;`]) {
      expect(() => writeOfficeProofInclude(path, proof)).toThrow('Invalid disposable office proof');
      expect(readFileSync(path).equals(before)).toBe(true);
    }
  });

  it('refuses a linked include rather than truncating another file', () => {
    const target = join(dir, 'untouched');
    writeFileSync(target, 'retained');
    const path = join(dir, 'linked.conf');
    symlinkSync(target, path);
    expect(() => writeOfficeProofInclude(path, 'e'.repeat(64))).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('retained');
  });

  it('interpolates only service credentials and read-only proof/blob mounts', async () => {
    await configureStack({ project: 'hawa-chaos-parity', envFile: join(dir, 'project.env') });
    const config = JSON.parse(compose(['--profile', 'candidate', '--profile', 'green', 'config', '--format', 'json']).stdout) as {
      services: Record<string, { environment?: Record<string, string>; volumes?: Array<{ target: string; source: string; read_only?: boolean }> }>;
    };
    for (const name of ['worker-blue', 'worker-green']) {
      const worker = config.services[name];
      const env = worker.environment!;
      expect(new URL(env.DATABASE_URL).username).toBe('hawa_worker_login');
      for (const key of ['HAWA_BEARER_TOKEN', 'HAWA_API_KEY', 'HAWA_ADMIN_KEY', 'HAWA_ART_DIRECTOR_KEY',
        'HAWA_OFFICE_PROXY_PROOF', 'HAWA_ACTION_HMAC_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY', 'CANVA_CLIENT_SECRET', 'CANVA_TOKEN_ENCRYPTION_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) {
        expect(Object.hasOwn(env, key), `${name} must not receive ${key}`).toBe(false);
      }
      expect(!!env.HAWA_WORKER_TOKEN && !!env.HAWA_DESIGN_WORKER_TOKEN).toBe(true);
      expect(env.HAWA_DESIGN_WORKER_TOKEN !== config.services.core.environment!.HAWA_BEARER_TOKEN).toBe(true);
      expect(worker.volumes?.some(v => v.target === '/var/lib/hawa/blobs' && v.read_only)).toBe(true);
    }
    const mount = config.services.nginx.volumes?.find(v => v.target === '/etc/nginx/hawa-office-proof.conf');
    expect(mount?.source === officeProofFile() && mount.read_only === true).toBe(true);
    expect(readFileSync(officeProofFile(), 'utf8').includes(config.services.core.environment!.HAWA_OFFICE_PROXY_PROOF)).toBe(true);
    expect(officeProofFile().startsWith(envFile())).toBe(true);
  });

  it('the generated include passes actual production nginx validation in its pinned image', () => {
    const proof = join(dir, 'nginx-proof.conf');
    writeOfficeProofInclude(proof, randomBytes(32).toString('hex'));
    const result = spawnSync('docker', ['run', '--rm', '--pull=never', '--add-host', 'core:127.0.0.1',
      '--add-host', 'desk:127.0.0.1', '-v', `${join(REPO_ROOT, 'infra/docker/nginx.conf')}:/etc/nginx/nginx.conf:ro`,
      '-v', `${proof}:/etc/nginx/hawa-office-proof.conf:ro`, 'nginx:1.27-alpine-slim', 'nginx', '-t'],
    { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(0);
  }, 40_000);
});
