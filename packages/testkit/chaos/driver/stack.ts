/**
 * The driver's hold on the hawa-chaos compose project: bring it up, kill and start its containers,
 * read its database, Restate and fakes, and take it down again.
 *
 * Every docker command names the project and a service of docker-compose.chaos.yml, and every
 * container name is checked to start with `hawa-chaos-` before it is killed: nothing here can touch
 * the office's hawa-production or hawa-test projects.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, sql, type Database, type Kysely } from '@hawa/db';

export const PROJECT = 'hawa-chaos';
export const CHAOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(CHAOS_DIR, '..', '..', '..');
const COMPOSE_FILE = join(CHAOS_DIR, 'docker-compose.chaos.yml');
const RUN_DIR = join(CHAOS_DIR, '.run');
const ENV_FILE = join(RUN_DIR, 'chaos.env');
export const RECOVERY_OVERRIDE = join(RUN_DIR, 'recovery.compose.json');

export const PORTS = { postgres: 56432, restateAdmin: 56070, restateIngress: 56080, fakes: 56090 } as const;
export const FAKES_URL = `http://127.0.0.1:${PORTS.fakes}`;
export const RESTATE_ADMIN_URL = `http://127.0.0.1:${PORTS.restateAdmin}`;
export const RESTATE_INGRESS_URL = `http://127.0.0.1:${PORTS.restateIngress}`;

export type Service = 'postgres' | 'restate' | 'core' | 'worker-blue' | 'worker-green' | 'fakes' | 'docling' | 'desk' | 'nginx';
const SERVICES: readonly Service[] = ['postgres', 'restate', 'core', 'worker-blue', 'worker-green', 'fakes', 'docling', 'desk', 'nginx'];

export interface ChaosSecrets {
  CHAOS_OWNER_PASSWORD: string;
  CHAOS_APP_PASSWORD: string;
  CHAOS_BEARER_TOKEN: string;
  CHAOS_REVIEWER_KEY: string;
  CHAOS_ADMIN_KEY: string;
  CHAOS_HMAC_SECRET: string;
  CHAOS_BOT_TOKEN: string;
  CHAOS_WEBHOOK_SECRET: string;
  CHAOS_CANVA_SECRET: string;
  CHAOS_CANVA_KEY: string;
  /** HAWA_WORKER_TOKEN (Phase 2.1): the worker's credential for Core's /v1/internal/*. */
  CHAOS_WORKER_TOKEN: string;
  CHAOS_AVAILABILITY_SECRET: string;
}

/**
 * Throwaway credentials for one life of the project, kept in .run/chaos.env (gitignored) so a kept
 * project (--keep) can be inspected and reused; deleted with the volumes, since a new Postgres volume
 * takes new ones. Never printed.
 */
export function secrets(): ChaosSecrets {
  const hex = (n: number) => randomBytes(n).toString('hex');
  const made: ChaosSecrets = {
    CHAOS_OWNER_PASSWORD: hex(16),
    CHAOS_APP_PASSWORD: hex(16),
    CHAOS_BEARER_TOKEN: hex(24),
    CHAOS_REVIEWER_KEY: hex(24),
    CHAOS_ADMIN_KEY: hex(24),
    CHAOS_HMAC_SECRET: hex(24),
    // Telegram's token shape: digits, a colon, then letters.
    CHAOS_BOT_TOKEN: `7000001:${hex(17)}`,
    CHAOS_WEBHOOK_SECRET: hex(24),
    CHAOS_CANVA_SECRET: hex(16),
    CHAOS_CANVA_KEY: hex(32),
    CHAOS_WORKER_TOKEN: hex(24),
    CHAOS_AVAILABILITY_SECRET: hex(32),
  };
  if (existsSync(ENV_FILE)) {
    const out: Record<string, string> = {};
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    // A kept project from before a key was added gets the new key; the existing ones stay (the
    // Postgres volume holds their passwords).
    const missing = Object.keys(made).filter((k) => !out[k]);
    if (!missing.length) return out as unknown as ChaosSecrets;
    for (const k of missing) out[k] = made[k as keyof ChaosSecrets];
    writeFileSync(ENV_FILE, Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    return out as unknown as ChaosSecrets;
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(ENV_FILE, Object.entries(made).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return made;
}

function run(cmd: string, args: string[], options: { allowFail?: boolean; timeoutMs?: number; quiet?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { cwd: CHAOS_DIR, encoding: 'utf8', timeout: options.timeoutMs ?? 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const status = res.status ?? -1;
  if (status !== 0 && !options.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${status}): ${(res.stderr || res.stdout || String(res.error || '')).slice(-2000)}`);
  }
  return { status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

export function compose(args: string[], options: { allowFail?: boolean; timeoutMs?: number } = {}) {
  secrets();
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE,
    ...(existsSync(RECOVERY_OVERRIDE) ? ['-f', RECOVERY_OVERRIDE] : []), '--env-file', ENV_FILE, ...args], options);
}

function containerOf(service: Service): string {
  if (!SERVICES.includes(service)) throw new Error(`unknown chaos service ${service}`);
  const name = `${PROJECT}-${service}-1`;
  if (!name.startsWith('hawa-chaos-')) throw new Error(`refusing to touch ${name}`);
  return name;
}

/**
 * Builds the images of these services from this checkout. `up` builds only the services it starts,
 * and Core and the worker are started later with --no-build (after the database is provisioned), so
 * they ran whatever hawa-chaos-core:local and hawa-chaos-worker:local an earlier run, possibly of
 * another worktree, had left: a fix under test was not in the containers (R1.K9, 2026-09-24).
 */
export function build(services: Service[]): void {
  compose(['build', ...services], { timeoutMs: 45 * 60 * 1000 });
}

/** Starts these services, building their images from this checkout unless `build` is false. */
export function up(options: { build?: boolean; services?: Service[] } = {}): void {
  compose(['up', '-d', '--wait', '--wait-timeout', '240', ...(options.build === false ? ['--no-build'] : ['--build']), ...(options.services || ['postgres', 'restate', 'fakes', 'core', 'worker-blue'])], { timeoutMs: 45 * 60 * 1000 });
}

/**
 * Stops and removes the project; with volumes, its data, its CA and its throwaway credentials too.
 * The results of the last run (.run/last-run.json) stay.
 */
export function down(options: { volumes?: boolean } = {}): void {
  // Compose knows inactive-profile containers, so --remove-orphans does not remove them.
  // Include every profile: otherwise candidate nginx keeps the blob volume alive across resets.
  compose(['--profile', 'green', '--profile', 'candidate', 'down', '--remove-orphans', ...(options.volumes ? ['-v'] : [])]);
  if (existsSync(RECOVERY_OVERRIDE) && options.volumes) {
    rmSync(RECOVERY_OVERRIDE);
    // The original stores stay untouched during recovery; remove them only with explicit teardown.
    compose(['--profile', 'green', '--profile', 'candidate', 'down', '--remove-orphans', '-v']);
  }
  if (options.volumes) {
    const old = run('docker', ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=hawa-chaos',
      '--filter', 'label=hawa.recovery-drill']).stdout.trim().split('\n').filter(Boolean);
    for (const volume of old) {
      if (!/^hawa-recovery-[0-9a-f]{16}-(postgres|restate|blobs)$/.test(volume)) throw new Error('Unexpected recovery volume identity');
      run('docker', ['volume', 'rm', volume]);
    }
  }
  if (options.volumes) rmSync(ENV_FILE, { force: true });
}

/** SIGKILL, as the kernel's OOM killer or a power cut of the process would. */
export function kill(service: Service): void {
  run('docker', ['kill', '-s', 'KILL', containerOf(service)], { allowFail: true });
}

export function start(service: Service): void {
  run('docker', ['start', containerOf(service)]);
}

export function isRunning(service: Service): boolean {
  const res = run('docker', ['inspect', '-f', '{{.State.Running}}', containerOf(service)], { allowFail: true });
  return res.stdout.trim() === 'true';
}

/** Waits until the container reports healthy (or, without a health check, running). */
export async function waitHealthy(service: Service, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = run('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerOf(service)], { allowFail: true });
    const state = res.stdout.trim();
    if (state === 'healthy' || state === 'running') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${service} did not become healthy within ${timeoutMs} ms`);
}

export function logs(service: Service, tail = 200): string {
  return run('docker', ['logs', '--tail', String(tail), containerOf(service)], { allowFail: true }).stdout + run('docker', ['logs', '--tail', String(tail), containerOf(service)], { allowFail: true }).stderr;
}

/**
 * Each chaos container's state (running, exit code, OOM kill, when it finished): recorded when a
 * scenario loses the stack, so a run that stops answering says which container went and how.
 */
export function stackState(): string {
  const res = run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}'], { allowFail: true });
  const names = res.stdout.split('\n').map((n) => n.trim()).filter((n) => n.startsWith(`${PROJECT}-`));
  if (!names.length) return 'no hawa-chaos containers exist';
  return names.map((name) => {
    const state = run('docker', ['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}', name], { allowFail: true });
    return `${name}: ${state.stdout.trim() || state.stderr.trim()}`;
  }).join('; ');
}

/** Memory in use per chaos container, in MiB, from one `docker stats` sample. */
export function memory(): Record<string, number> {
  const res = run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}'], { allowFail: true });
  const out: Record<string, number> = {};
  for (const line of res.stdout.split('\n')) {
    const [name, usage] = line.split('\t');
    if (!name?.startsWith(`${PROJECT}-`) || !usage) continue;
    const m = /([\d.]+)\s*([KMG]i?B)/.exec(usage);
    if (!m) continue;
    const n = Number(m[1]);
    out[name] = Math.round(m[2].startsWith('G') ? n * 1024 : m[2].startsWith('K') ? n / 1024 : n);
  }
  return out;
}

let pool: Kysely<Database> | null = null;
/** The owner's connection to the chaos database (never the office's: port 56432, database hawa_chaos). */
export function db(): Kysely<Database> {
  if (!pool) pool = createDb(`postgresql://hawa_owner:${secrets().CHAOS_OWNER_PASSWORD}@127.0.0.1:${PORTS.postgres}/hawa_chaos`, { max: 3 });
  return pool;
}
export async function closeDb(): Promise<void> {
  await pool?.destroy().catch(() => undefined);
  pool = null;
}

/** One SQL statement as the owner; `$1` style parameters are not used, values are bound through `sql`. */
export async function query<T = any>(statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await statement.execute(db())).rows as T[];
}
export { sql };

/** Restate's SQL introspection (sys_invocation, sys_journal …). */
export async function restateQuery<T = any>(sql: string): Promise<T[]> {
  const res = await fetch(`${RESTATE_ADMIN_URL}/query`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!res.ok) throw new Error(`Restate query failed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { rows: T[] }).rows;
}

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const res = await fetch(`${FAKES_URL}${path}`, {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

export const fakes = {
  reset: () => call('/__fakes/reset', { body: {} }),
  /** Drops armed faults and chaos holds (the logs and ledgers stay). */
  clearFaults: () => call('/__fakes/faults/clear', { body: {} }),
  updates: (updates: any[]) => call('/__fakes/telegram/updates', { body: { updates } }).then((r) => r.json.updateIds as number[]),
  telegramFault: (fault: Record<string, unknown>) => call('/__fakes/telegram/faults', { body: fault }),
  file: (file: Record<string, unknown>) => call('/__fakes/telegram/files', { body: file }),
  sent: () => call('/__fakes/telegram/sent').then((r) => r.json.sent as any[]),
  polls: () => call('/__fakes/telegram/polls').then((r) => r.json),
  /** Bot API calls as they arrived (before any delay or fault answered them); getUpdates left out. */
  telegramCalls: () => call('/__fakes/telegram/calls').then((r) => r.json.calls as Array<{ method: string; at: string; chat?: string | null }>),
  canvaFault: (fault: Record<string, unknown>) => call('/__fakes/canva/faults', { body: fault }),
  driveFiles: () => call('/__fakes/drive/files').then((r) => r.json.files as any[]),
  googleDelay: (delay: { path: string; delayMs: number; n?: number }) => call('/__fakes/google/faults', { body: delay }),
  canvaLedger: () => call('/__fakes/canva/ledger').then((r) => r.json.ledger as any[]),
  canvaManualEdit: (body: {designId:string;contentBase64:string}) => call('/__fakes/canva/manual-edit', {body}),
  modelLedger: () => call('/__fakes/models/ledger').then((r) => r.json),
  modelDelay: (delay: { schema: string; delayMs: number; n?: number }) => call('/__fakes/models/delays', { body: delay }),
  hold: (point: string, match: Record<string, string> = {}, n = 1) => call('/__chaos/hold', { body: { point, match, n } }),
  wait: (point: string, timeoutMs = 120_000) => call(`/__chaos/wait?point=${encodeURIComponent(point)}&timeoutMs=${timeoutMs}`).then((r) => (r.status === 200 ? r.json : null)),
  release: (point?: string) => call('/__chaos/release', { body: point ? { point } : {} }),
  reached: () => call('/__chaos/reached').then((r) => r.json.reached as any[]),
  /** Core's API, as the Desk calls it, with a bearer. */
  core: (path: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    call(`/__core${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }),
};

/** Sanitized identity receipt: image IDs and network names, never container environment/secrets. */
export function deploymentReceipt() {
  const commit = run('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']).stdout.trim();
  const changed = [...new Set([
    ...run('git', ['-C', REPO_ROOT, 'diff', 'HEAD', '--name-only']).stdout.trim().split('\n'),
    ...run('git', ['-C', REPO_ROOT, 'ls-files', '--others', '--exclude-standard']).stdout.trim().split('\n'),
  ])].filter(p => /^(apps|packages|infra|services)\//.test(p));
  const sourceChanges = Object.fromEntries(changed.map(p => [p, existsSync(join(REPO_ROOT, p))
    ? createHash('sha256').update(readFileSync(join(REPO_ROOT, p))).digest('hex') : 'deleted']));
  const containers = Object.fromEntries(SERVICES.flatMap(service => {
    const result = run('docker', ['inspect', '--format',
      '{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{end}}|{{.Created}}',
      containerOf(service)], { allowFail: true });
    if (result.status !== 0) return [];
    const [imageId, buildCommit, networks, createdAt] = result.stdout.trim().split('|');
    return [[service, { imageId, buildCommit, networks: networks.trim().split(/\s+/), createdAt }]];
  }));
  const networks = run('docker', ['network', 'inspect', `${PROJECT}_chaos`, `${PROJECT}_parser`,
    '--format', '{{.Name}}|{{.Internal}}'], { allowFail: true }).stdout.trim().split('\n');
  return { commit, sourceChanges, containers, networks, externalAdapters: 'synthetic fakes',
    parser: 'real pinned offline Docling', productionChanged: false };
}
