/**
 * The driver's hold on the hawa-chaos compose project: bring it up, kill and start its containers,
 * read its database, Restate and fakes, and take it down again.
 *
 * Every docker command names the project and a service of docker-compose.chaos.yml, and every
 * container name is checked to start with `hawa-chaos-` before it is killed: nothing here can touch
 * the office's hawa-production or hawa-test projects.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, sql, type Database, type Kysely } from '@hawa/db';

export const CHAOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(CHAOS_DIR, '..', '..', '..');
const COMPOSE_FILE = join(CHAOS_DIR, 'docker-compose.chaos.yml');
const RUN_DIR = join(CHAOS_DIR, '.run');
export const RECOVERY_OVERRIDE = join(RUN_DIR, 'recovery.compose.json');
/**
 * The release Core and the workers are created from, when it is not this checkout's (the R10
 * scenarios' previous release, driver/cutover.ts): image tags and that release's own settings.
 * Removed with the volumes, so a later run starts on this checkout's images.
 */
export const RELEASE_OVERRIDE = join(RUN_DIR, 'release.compose.json');

export interface StackPorts { postgres: number; restateAdmin: number; restateIngress: number; fakes: number }
const DEFAULT_PROJECT = 'hawa-chaos';
const DEFAULT_PORTS: StackPorts = { postgres: 56432, restateAdmin: 56070, restateIngress: 56080, fakes: 56090 };

// The shared hawa-chaos project by default. A drill that must not share it (the R10 clean-host restore,
// ADR-134) names its own project, ports and image tag with configureStack() before it starts anything.
// These are live bindings: every importer sees the configured values.
export let PROJECT = DEFAULT_PROJECT;
export let PORTS: Readonly<StackPorts> = { ...DEFAULT_PORTS };
export let FAKES_URL = `http://127.0.0.1:${PORTS.fakes}`;
export let RESTATE_ADMIN_URL = `http://127.0.0.1:${PORTS.restateAdmin}`;
export let RESTATE_INGRESS_URL = `http://127.0.0.1:${PORTS.restateIngress}`;
let ENV_FILE = join(RUN_DIR, 'chaos.env');
let EXTRA_COMPOSE_FILES: string[] = [];
let IMAGE_TAG: string | null = null;

export interface StackTarget {
  /** `hawa-chaos` or `hawa-chaos-<suffix>`: every container name keeps the `hawa-chaos-` prefix the kill guard checks. */
  project: string;
  ports?: Partial<StackPorts>;
  /** Tag of the hawa-chaos-core/worker/fakes images (default `local`, shared with every hawa-chaos run). */
  imageTag?: string;
  /** Compose files merged after docker-compose.chaos.yml (bind mounts, external volumes, pinned image IDs). */
  composeFiles?: string[];
  /** Where the throwaway credentials live (default .run/<project>.env; .run/chaos.env for hawa-chaos). */
  envFile?: string;
}

/**
 * Points every helper here at another compose project. Defaults are today's hawa-chaos values, so a
 * caller that never configures anything is unchanged. Closes the owner pool of the previous target.
 */
export async function configureStack(target: StackTarget): Promise<void> {
  if (!/^hawa-chaos(-[a-z0-9]{1,24})?$/.test(target.project)) throw new Error(`refusing chaos project name ${target.project}`);
  if (target.imageTag !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(target.imageTag)) throw new Error('invalid chaos image tag');
  const ports = { ...DEFAULT_PORTS, ...(target.ports || {}) };
  for (const port of Object.values(ports)) {
    if (!Number.isInteger(port) || port < 50_000 || port > 65_000) throw new Error(`chaos port ${port} is outside 50000-65000`);
  }
  await closeDb();
  PROJECT = target.project;
  PORTS = ports;
  FAKES_URL = `http://127.0.0.1:${ports.fakes}`;
  RESTATE_ADMIN_URL = `http://127.0.0.1:${ports.restateAdmin}`;
  RESTATE_INGRESS_URL = `http://127.0.0.1:${ports.restateIngress}`;
  ENV_FILE = target.envFile ?? join(RUN_DIR, target.project === DEFAULT_PROJECT ? 'chaos.env' : `${target.project}.env`);
  EXTRA_COMPOSE_FILES = [...(target.composeFiles || [])];
  IMAGE_TAG = target.imageTag ?? null;
}

/** The environment compose interpolates for the configured target (ports and image tag). */
function composeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHAOS_PORT_POSTGRES: String(PORTS.postgres),
    CHAOS_PORT_RESTATE_ADMIN: String(PORTS.restateAdmin),
    CHAOS_PORT_RESTATE_INGRESS: String(PORTS.restateIngress),
    CHAOS_PORT_FAKES: String(PORTS.fakes),
    ...(IMAGE_TAG ? { CHAOS_IMAGE_TAG: IMAGE_TAG } : {}),
  };
}

/** The throwaway credentials file of the configured target. */
export function envFile(): string {
  return ENV_FILE;
}

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
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, Object.entries(made).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return made;
}

export function run(cmd: string, args: string[], options: { allowFail?: boolean; timeoutMs?: number; quiet?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { cwd: CHAOS_DIR, encoding: 'utf8', timeout: options.timeoutMs ?? 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: composeEnvironment() });
  const status = res.status ?? -1;
  if (status !== 0 && !options.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${status}): ${(res.stderr || res.stdout || String(res.error || '')).slice(-2000)}`);
  }
  return { status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

export function compose(args: string[], options: { allowFail?: boolean; timeoutMs?: number } = {}) {
  secrets();
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE,
    ...(PROJECT === DEFAULT_PROJECT && existsSync(RECOVERY_OVERRIDE) ? ['-f', RECOVERY_OVERRIDE] : []),
    ...(PROJECT === DEFAULT_PROJECT && existsSync(RELEASE_OVERRIDE) ? ['-f', RELEASE_OVERRIDE] : []),
    ...EXTRA_COMPOSE_FILES.flatMap((file) => ['-f', file]), '--env-file', ENV_FILE, ...args], options);
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

/** Set by down({ volumes: true }): the next Postgres this driver starts must initialise its own database. */
let expectFreshDatabase = false;

/** Starts these services, building their images from this checkout unless `build` is false. */
export function up(options: { build?: boolean; services?: Service[] } = {}): void {
  const services = options.services || ['postgres', 'restate', 'fakes', 'core', 'worker-blue'];
  compose(['up', '-d', '--wait', '--wait-timeout', '240', ...(options.build === false ? ['--no-build'] : ['--build']), ...services], { timeoutMs: 45 * 60 * 1000 });
  if (expectFreshDatabase && services.includes('postgres')) {
    expectFreshDatabase = false;
    // After this run's own down -v, a data directory that is already there was made by another run,
    // with the passwords of its own .run/chaos.env: every login of this run would then fail with
    // "password authentication failed for user hawa_owner" (2026-09-28, twice).
    if (logs('postgres', 1000).includes('Skipping initialization')) {
      throw new Error('the hawa-chaos Postgres was initialised by another run, not this one: another checkout started the project between this run\'s down and up (it has its own .run/chaos.env). Let one run finish, then start again.');
    }
  }
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
  if (options.volumes) {
    rmSync(ENV_FILE, { force: true });
    if (PROJECT === DEFAULT_PROJECT) rmSync(RELEASE_OVERRIDE, { force: true });
    expectFreshDatabase = true;
  }
}

/**
 * The project's lock: one run at a time on this machine, from its first down to its last.
 *
 * The project name, ports and volumes are fixed, but every checkout keeps its own .run/chaos.env.
 * Two runs that overlapped (a load run started while another checkout's chaos suite was between its
 * down and its up, when no container runs) shared one Postgres volume initialised with the other's
 * passwords, and the later one failed at its first login (2026-09-28, 2 of 9 load runs).
 *
 * The lock is a running container, hawa-chaos-lock: Docker refuses a second container of that name,
 * so taking it is atomic across checkouts and agents (they share only the Docker daemon, not a temp
 * directory). It runs `cat` on the holder's stdin pipe with --rm, so it goes away when the holder
 * does, however it ends (even SIGKILL: the pipe closes, cat reads EOF). Older load runners, which
 * wait while any hawa-chaos-* container runs, wait for it too. Same container and labels as the lock
 * written on claude/objective-hellman-2d66cb, so the two implementations exclude each other.
 */
export const LOCK_CONTAINER = `${PROJECT}-lock`;
/** An image the stack pulls anyway; the container only runs cat, with no network. */
const LOCK_IMAGE = 'pgvector/pgvector:pg17';
let held: ChildProcess | null = null;

interface LockHolder { id: string; running: boolean; token: string; dir: string; command: string; since: string }

function lockHolder(): LockHolder | null {
  const format = ['{{.Id}}', '{{.State.Running}}', ...['token', 'dir', 'command', 'since'].map((k) => `{{index .Config.Labels "hawa.chaos.lock.${k}"}}`)].join('\t');
  const res = run('docker', ['inspect', '-f', format, LOCK_CONTAINER], { allowFail: true });
  if (res.status !== 0) return null;
  const [id, running, token, dir, command, since] = res.stdout.trim().split('\t');
  return { id, running: running === 'true', token, dir, command, since };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the lock container; null when this process now holds it, otherwise who does. */
async function tryLock(): Promise<LockHolder | null> {
  const token = randomBytes(12).toString('hex');
  const child = spawn('docker', [
    'run', '-i', '--rm', '--name', LOCK_CONTAINER, '--network', 'none', '--memory', '16m', '--entrypoint', 'cat',
    '--label', `hawa.chaos.lock.token=${token}`, '--label', `hawa.chaos.lock.dir=${CHAOS_DIR}`,
    '--label', `hawa.chaos.lock.command=${process.argv.slice(1).join(' ').slice(0, 300)}`,
    '--label', `hawa.chaos.lock.since=${new Date().toISOString()}`, LOCK_IMAGE,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  let exited = false;
  child.on('exit', () => (exited = true));
  // Minutes only when the image has to be pulled first.
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const now = lockHolder();
    if (now?.running && now.token === token) {
      held = child;
      // The lock must not keep this process alive; it ends with the process.
      child.unref();
      (child.stdin as unknown as { unref(): void }).unref();
      (child.stderr as unknown as { unref(): void }).unref();
      return null;
    }
    if (exited) {
      if (!/already in use|Conflict/i.test(stderr)) throw new Error(`taking the hawa-chaos lock failed: ${stderr.trim().slice(-500)}`);
      const other = lockHolder();
      if (!other) return tryLock();
      // A lock container left stopped (the daemon restarted under it): remove that one, by id.
      if (!other.running) {
        run('docker', ['rm', '-f', '-v', other.id], { allowFail: true });
        return tryLock();
      }
      return other;
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('taking the hawa-chaos lock: docker run neither started nor refused within 10 minutes');
}

/**
 * Takes the project's lock, waiting up to `waitMs` (30 minutes by default) while another run holds it.
 * Call it before the first down of a run; releaseProject() after the last.
 */
export async function acquireProject(options: { waitMs?: number; log?: (line: string) => void } = {}): Promise<void> {
  if (held) return;
  const deadline = Date.now() + (options.waitMs ?? 30 * 60_000);
  let told = 0;
  for (;;) {
    const other = await tryLock();
    if (!other) return;
    const who = `a run in ${other.dir} since ${other.since} (${other.command})`;
    if (Date.now() >= deadline) throw new Error(`hawa-chaos is held by ${who}; not starting`);
    if (Date.now() - told >= 30_000) {
      (options.log ?? console.log)(`hawa-chaos is held by ${who}; waiting`);
      told = Date.now();
    }
    // Short, so a waiting run usually takes the lock before its holder's next run has started.
    await sleep(2000);
  }
}

/** Gives the lock back (a no-op when this process does not hold it) and waits until it is gone. */
export async function releaseProject(): Promise<void> {
  const child = held;
  held = null;
  if (!child) return;
  const gone = new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));
  child.stdin?.end();
  await Promise.race([gone, sleep(15_000)]);
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
    // This project's services only: not hawa-chaos-lock, nor another project whose name starts
    // with hawa-chaos- (another agent's hawa-chaos-r10s ran beside this suite on 2026-09-28).
    if (!name || !usage || !SERVICES.some((service) => name === `${PROJECT}-${service}-1`)) continue;
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

/**
 * A pooled keep-alive socket the fakes server closed as idle while this process was blocked in a
 * synchronous `docker compose` (spawnSync) fails the next request before the server read it
 * (undici: "other side closed", UND_ERR_SOCKET). That request never arrived, so it is sent once more
 * on a fresh socket (R10.K1's rollback, 2026-09-29).
 */
const staleSocket = (err: unknown) => err instanceof TypeError &&
  (err.cause as { code?: string } | undefined)?.code === 'UND_ERR_SOCKET';

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const request = () => fetch(`${FAKES_URL}${path}`, {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const res = await request().catch((err) => { if (staleSocket(err)) return request(); throw err; });
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
