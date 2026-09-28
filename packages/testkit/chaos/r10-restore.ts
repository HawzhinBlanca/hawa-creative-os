#!/usr/bin/env tsx
/**
 * R10 clean-host restore drill (ADR-134): the nightly backup, run as the office runs it, then a restore
 * of one paired night onto a separate, clean compose project, with in-flight work that must finish
 * exactly once.
 *
 *   HAWA_R10_SCRATCH=<empty private directory> npx tsx packages/testkit/chaos/r10-restore.ts
 *   HAWA_R10_KEEP=1   leave both projects up afterwards (take them down with --down)
 *   --down            remove both projects, their volumes and the throwaway credentials
 *
 * Two projects, neither of them the shared hawa-chaos: the source hawa-chaos-r10s (ports 57xxx) plays the
 * office, and the destination hawa-chaos-r10d (ports 58xxx) is the clean host. Both run the images
 * hawa-chaos-{core,worker,fakes}:r10 built from this checkout (build them first:
 * packages/testkit/chaos/README.md, "R10 clean-host restore"). Telegram, Canva, Drive and the models are
 * the chaos fakes; the source's fakes container is the outside world and survives the loss of the
 * source host, so its ledgers see every effect of both hosts.
 *
 *  1. Source up with the worker's poller (production's lifecycle path). Chat A reaches office review.
 *  2. Night 1: infra/backup/nightly_backup.sh with HAWA_RESTATE_BACKUP_ENABLED=on, every location and
 *     name pointed at this drill. A monitor samples the persisted Telegram switch and the Restate
 *     container every 250 ms; a brief for chat E is queued in Telegram while Restate is stopped.
 *  3. In-flight work: chat B's office revision (a requester notice held by Telegram 429s in its
 *     TelegramSender, and a 24-hour reminder timer), chat C's brief held inside Core's intake (a running
 *     ChatInbox invocation). The source worker is then frozen, so no effect leaves the source after the
 *     capture: this isolates restore correctness from the recovery point (what happened after the last
 *     backup is not in it, by definition).
 *  4. Night 2: the same nightly; then the source host is lost (its Postgres, Restate, Core and worker
 *     containers and their volumes are removed).
 *  5. Restore on the destination from the archive alone: the pair is verified, the dump goes through the
 *     runbook's own restore-swap block, the file packs are unpacked as the runbook says, the Restate
 *     archive is restored with restate_restore_rehearsal.py --restore-into, and exactly one Restate node
 *     and one worker start on the recorded image IDs.
 *  6. The in-flight work resumes; chat A is approved and delivered; every effect is counted.
 *
 * The receipt (.run/r10-restore.json) holds identities, timings and counts, never credentials or
 * message text.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  CHAOS_DIR, PORTS, REPO_ROOT, closeDb, compose, configureStack, envFile, fakes, query, restateQuery, secrets, sql, up,
  type StackPorts,
} from './driver/stack.js';
import { connectCanva, kaaeClientDna, registerColour, upgradeSchema } from './driver/provision.js';
import {
  OFFICE_CHAT, RequestEndedError, approve, briefText, briefToDraft, checkRequest, deliver, sendBrief, sentTo, sleep, tasksOfChat,
  textUpdate, waitDelivered, waitUntil, type InvariantResult,
} from './driver/scenario.js';

const execFileAsync = promisify(execFile);

const SRC = 'hawa-chaos-r10s';
const DST = 'hawa-chaos-r10d';
const SRC_PORTS: StackPorts = { postgres: 57432, restateAdmin: 57070, restateIngress: 57080, fakes: 57090 };
// The destination has no fakes of its own: the source's fakes container is the outside world.
const DST_PORTS: StackPorts = { postgres: 58432, restateAdmin: 58070, restateIngress: 58080, fakes: 57090 };
const TAG = 'r10';
// Not the shared chaos stack's node name: the restore refuses while any running container carries the
// archived node name, and another session's hawa-chaos may be running on this host.
const NODE = 'hawa-restate-r10-1';
const RESTATE_TAG = 'ghcr.io/restatedev/restate:1.7.10';
const CHAOS_COMPOSE = join(CHAOS_DIR, 'docker-compose.chaos.yml');
const RUN_DIR = join(CHAOS_DIR, '.run');
const RECEIPT = join(RUN_DIR, 'r10-restore.json');
const RESTORED_RESTATE_VOLUME = `${DST}-restored-restate`;
// Lifecycle chats (docker-compose.chaos.yml HAWA_LIFECYCLE_CHATS).
const CHAT = { A: '9300001', B: '9300002', C: '9300003', E: '9300005' } as const;
// Production's Restate health check cadence (docker-compose.prod.yml), so the measured pause matches it.
const PROD_HEALTHCHECK = { interval: '10s', timeout: '5s', retries: 10 };
const PERSISTED_SWITCH = sql`SELECT CASE WHEN EXISTS (
  SELECT 1 FROM hawa.integrations i JOIN hawa.integration_health h ON h.integration_id = i.id
  WHERE i.tenant_id = '00000000-0000-4000-a000-000000000001'::uuid
    AND i.kind = 'telegram' AND i.name = 'office-kill-switch' AND h.state = 'disabled') THEN 'f' ELSE 't' END AS on`;

// ------------------------------------------------------------------------------------------------
// Shell helpers. Output is kept for the receipt only as counts and identities.

interface Result { status: number; stdout: string; stderr: string; ms: number }
function sh(cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer | string; cwd?: string; timeoutMs?: number; allowFail?: boolean } = {}): Result {
  const started = Date.now();
  const res = spawnSync(cmd, args, { cwd: options.cwd ?? REPO_ROOT, env: options.env ?? process.env, input: options.input,
    encoding: 'utf8', timeout: options.timeoutMs ?? 30 * 60_000, maxBuffer: 256 * 1024 * 1024 });
  const out = { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '', ms: Date.now() - started };
  if (out.status !== 0 && !options.allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (${out.status}): ${(out.stderr || out.stdout || String(res.error || '')).slice(-1500)}`);
  }
  return out;
}
function runAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr, ms: Date.now() - started }));
  });
}
const docker = (...args: string[]) => sh('docker', args).stdout.trim();
const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

/** Replaces every throwaway credential of both drill projects (and the archive key) with <redacted>. */
function scrub(text: string): string {
  const values: string[] = [];
  for (const project of [SRC, DST]) {
    const file = join(RUN_DIR, `${project}.env`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.+)$/.exec(line);
      if (m && /PASSWORD|TOKEN|KEY|SECRET/.test(m[1]) && m[2].length >= 8) values.push(m[2]);
    }
  }
  const root = process.env.HAWA_R10_SCRATCH;
  if (root && existsSync(join(root, 'archive.key'))) values.push(readFileSync(join(root, 'archive.key'), 'utf8').trim());
  return values.reduce((out, v) => out.split(v).join('<redacted>'), text);
}

function guardName(name: string): string {
  if (!name.startsWith(`${SRC}-`) && !name.startsWith(`${SRC}_`) && !name.startsWith(`${DST}-`) && !name.startsWith(`${DST}_`)) {
    throw new Error(`refusing to touch ${name}: not a drill resource`);
  }
  return name;
}

// ------------------------------------------------------------------------------------------------
// Receipt.

const checks: InvariantResult[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`[r10] ${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
}
const receipt: Record<string, any> = { drill: 'R10 clean-host restore (ADR-134)', startedAt: new Date().toISOString(),
  productionTouched: false, commands: [] as string[], timings: {} as Record<string, number | string> };
const note = (line: string) => { console.log(`[r10] ${line}`); (receipt.events ??= []).push(`${new Date().toISOString()} ${line}`); };

// ------------------------------------------------------------------------------------------------
// Scratch layout and environment.

function scratchRoot(): string {
  const root = process.env.HAWA_R10_SCRATCH;
  if (!root || !root.startsWith('/')) throw new Error('set HAWA_R10_SCRATCH to an absolute, empty, private directory');
  if (root.startsWith(REPO_ROOT)) throw new Error('HAWA_R10_SCRATCH must be outside the repository');
  return root;
}
function paths(root: string) {
  return {
    root, key: join(root, 'archive.key'), archive: join(root, 'archive'), snapshots: join(root, 'snapshots'),
    logs: join(root, 'container-logs'), state: join(root, 'restate-backup.state'), restore: join(root, 'restore'),
    srcBlobs: join(root, 'src-blobs'), dstBlobs: join(root, 'dst-blobs'),
    srcOverride: join(root, 'src-override.yml'), dstOverride: join(root, 'dst-override.yml'),
    noNotify: join(root, 'no-notify.env'),
  };
}
type Paths = ReturnType<typeof paths>;

/** Non-secret compose interpolation values, written beside the throwaway credentials. */
function writeStackEnv(file: string, ports: StackPorts, commit: string): void {
  const kept = readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l) && !/^CHAOS_(PORT_|IMAGE_TAG|TELEGRAM_POLLER|BUILD_COMMIT|PG_)/.test(l));
  const extra = {
    CHAOS_PORT_POSTGRES: ports.postgres, CHAOS_PORT_RESTATE_ADMIN: ports.restateAdmin,
    CHAOS_PORT_RESTATE_INGRESS: ports.restateIngress, CHAOS_PORT_FAKES: ports.fakes,
    CHAOS_IMAGE_TAG: TAG, CHAOS_TELEGRAM_POLLER: 'worker', CHAOS_BUILD_COMMIT: commit,
    CHAOS_PG_FSYNC: 'on', CHAOS_PG_FULL_PAGE_WRITES: 'on',
  };
  writeFileSync(file, [...kept, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n', { mode: 0o600 });
}

function nightlyEnv(p: Paths, drainSeconds: number): NodeJS.ProcessEnv {
  // Nothing of the caller's HAWA_* settings reaches the nightly: every location is named here.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HAWA_')));
  const env: Record<string, string> = {
    HAWA_BACKUP_SNAPSHOT_DIR: p.snapshots,
    HAWA_BACKUP_PG_CONTAINER: `${SRC}-postgres-1`,
    HAWA_BACKUP_DB: 'hawa_chaos',
    HAWA_BACKUP_NOTIFY_ENV: p.noNotify,
    HAWA_BACKUP_MIN_BYTES: '1000',
    HAWA_BACKUP_ARCHIVE_DEST: p.archive,
    HAWA_BACKUP_ARCHIVE_DIR: p.archive,
    HAWA_BACKUP_ARCHIVE_KEYFILE: p.key,
    HAWA_CONTAINER_LOGS_DIR: p.logs,
    HAWA_BLOBS_DIR: p.srcBlobs,
    HAWA_BLOB_GC_CMD: `docker exec ${SRC}-core-1 node /app/apps/core/dist/tools/blob-gc.js`,
    HAWA_SCRATCH_DB_SUFFIX: 'r10',
    HAWA_RESTATE_BACKUP_ENABLED: 'on',
    HAWA_RESTATE_BACKUP_HELPER_IMAGE: helperImage(),
    HAWA_RESTATE_BACKUP_STATE: p.state,
    HAWA_RESTATE_BACKUP_COMPOSE_FILES: [CHAOS_COMPOSE, p.srcOverride].join(':'),
    HAWA_RESTATE_BACKUP_COMPOSE_ENV: envFile(),
    HAWA_RESTATE_BACKUP_COMPOSE_PROJECT: SRC,
    HAWA_RESTATE_BACKUP_VOLUME: `${SRC}_chaos_restate`,
    HAWA_RESTATE_BACKUP_CONTAINER: `${SRC}-restate-1`,
    HAWA_RESTATE_BACKUP_CORE_CONTAINER: `${SRC}-core-1`,
    HAWA_RESTATE_BACKUP_POSTGRES_CONTAINER: `${SRC}-postgres-1`,
    HAWA_RESTATE_BACKUP_NODE_NAME: NODE,
    HAWA_RESTATE_BACKUP_DATABASE: 'hawa_chaos',
    HAWA_RESTATE_BACKUP_DRAIN_SECONDS: String(drainSeconds),
  };
  for (const [k, v] of Object.entries(env)) {
    if (/hawa-production|\.hawa\/|snapshots_archive|HawaBackups/.test(v)) throw new Error(`nightly setting ${k} names a production location`);
  }
  return { ...base, ...env };
}

let helperCache: string | null = null;
/** The Restate image itself, by digest: local, pinned, and it has GNU tar. */
function helperImage(): string {
  if (!helperCache) {
    const digest = docker('image', 'inspect', RESTATE_TAG, '--format', '{{index .RepoDigests 0}}');
    if (!/^\S+@sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('the Restate image has no repository digest to pin');
    helperCache = digest;
  }
  return helperCache;
}

function imageId(ref: string): string {
  const id = docker('image', 'inspect', ref, '--format', '{{.Id}}');
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`no immutable image ID for ${ref}`);
  return id;
}

// ------------------------------------------------------------------------------------------------
// Observation: the persisted switch and the Restate container, sampled while a nightly runs.

interface Sample { t: number; switchOn: boolean | null; restate: string }
class Monitor {
  samples: Sample[] = [];
  private stopped = false;
  private done: Promise<void> | null = null;
  constructor(private readonly restateContainer: string) {}
  start(): void {
    this.done = (async () => {
      while (!this.stopped) {
        const t = Date.now();
        let switchOn: boolean | null = null;
        try { switchOn = (await query<{ on: string }>(PERSISTED_SWITCH))[0]?.on === 't'; } catch { switchOn = null; }
        let restate = 'unknown';
        try {
          restate = (await execFileAsync('docker', ['inspect', '-f', '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}', this.restateContainer])).stdout.trim();
        } catch { restate = 'missing'; }
        this.samples.push({ t, switchOn, restate });
        await sleep(Math.max(0, 250 - (Date.now() - t)));
      }
    })();
  }
  async stop(): Promise<void> { this.stopped = true; await this.done; }
  /** First sample time where `pred` holds, at or after `from`. */
  first(pred: (s: Sample) => boolean, from = 0): number | null {
    return this.samples.find((s) => s.t >= from && pred(s))?.t ?? null;
  }
  summary() {
    const pausedAt = this.first((s) => s.switchOn === false);
    const releasedAt = pausedAt === null ? null : this.first((s) => s.switchOn === true, pausedAt);
    const stoppedAt = this.first((s) => !s.restate.startsWith('running'));
    const healthyAt = stoppedAt === null ? null : this.first((s) => s.restate === 'running/healthy', stoppedAt);
    return {
      samples: this.samples.length, resolutionMs: 250,
      intakePausedAt: pausedAt && iso(pausedAt), intakeReleasedAt: releasedAt && iso(releasedAt),
      intakePausedSeconds: pausedAt && releasedAt ? (releasedAt - pausedAt) / 1000 : null,
      restateStoppedAt: stoppedAt && iso(stoppedAt), restateHealthyAgainAt: healthyAt && iso(healthyAt),
      restateUnavailableSeconds: stoppedAt && healthyAt ? (healthyAt - stoppedAt) / 1000 : null,
      unreadableSwitchSamples: this.samples.filter((s) => s.switchOn === null).length,
    };
  }
}

// ------------------------------------------------------------------------------------------------
// Effects the outside world has seen (the surviving fakes).

async function effects() {
  const sent = await fakes.sent();
  const delivered = sent.filter((s) => s.delivered);
  const byChat: Record<string, number> = {};
  for (const s of delivered) byChat[s.chat_id] = (byChat[s.chat_id] || 0) + 1;
  const canva = await fakes.canvaLedger();
  const drive = await fakes.driveFiles();
  const models = (await fakes.modelLedger()).ledger as any[];
  return {
    telegramDelivered: delivered.length, telegramRefused: sent.length - delivered.length, telegramDeliveredByChat: byChat,
    canvaOperations: canva.length, driveFiles: drive.length,
    paidModelCalls: models.filter((l) => l.status === 200 && l.route !== 'billing-probe').length,
    unmatchedModelCalls: models.filter((l) => String(l.route).startsWith('unmatched')).length,
  };
}

/** Every delivered Telegram message, file and notice, by chat: none may appear twice. */
async function duplicateSends(): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const s of (await fakes.sent()).filter((x) => x.delivered)) {
    const key = `${s.chat_id}:${s.method}:${s.documentSha256 ?? s.textHash}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k.slice(0, 40)}x${n}`);
}

async function paidCallsTwice(): Promise<string[]> {
  const paid = new Map<string, number>();
  for (const l of ((await fakes.modelLedger()).ledger as any[]).filter((x) => x.status === 200 && x.route !== 'billing-probe')) {
    paid.set(`${l.route}:${l.fingerprint}`, (paid.get(`${l.route}:${l.fingerprint}`) || 0) + 1);
  }
  return [...paid].filter(([, n]) => n > 1).map(([k, n]) => `${k.slice(0, 40)}x${n}`);
}

interface Invocation { id: string; target_service_name: string; target_service_key: string | null; target_handler_name: string;
  status: string; idempotency_key: string | null; pinned_deployment_id: string | null; scheduled_start_at?: string | null;
  last_failure_error_code?: string | null }
/** Every timestamp Restate records for one invocation (null fields are left out of its JSON rows). */
async function invocationTimes(id: string): Promise<Record<string, string>> {
  const [row] = await restateQuery<Record<string, unknown>>(`SELECT * FROM sys_invocation WHERE id = '${id.replace(/[^A-Za-z0-9_]/g, '')}'`);
  return Object.fromEntries(Object.entries(row ?? {}).filter(([k, v]) => k.endsWith('_at') && v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
}

async function openInvocations(): Promise<Invocation[]> {
  return restateQuery<Invocation>(`SELECT id, target_service_name, target_service_key, target_handler_name, status, idempotency_key,
    pinned_deployment_id, scheduled_start_at, last_failure_error_code FROM sys_invocation WHERE status <> 'completed' ORDER BY id`);
}

// ------------------------------------------------------------------------------------------------
// The two nights.

async function nightly(p: Paths, label: string, drainSeconds: number, during?: (m: Monitor, finished: () => boolean) => Promise<void>) {
  const monitor = new Monitor(`${SRC}-restate-1`);
  const restateBefore = docker('inspect', '-f', '{{.Id}}', `${SRC}-restate-1`);
  monitor.start();
  const env = nightlyEnv(p, drainSeconds);
  receipt.commands.push(`[${label}] bash infra/backup/nightly_backup.sh (env: ${Object.keys(env).filter((k) => k.startsWith('HAWA_')).sort().join(', ')})`);
  let finished = false;
  const job = runAsync('bash', ['infra/backup/nightly_backup.sh'], env).then((r) => { finished = true; return r; });
  const side = during ? during(monitor, () => finished).catch((err) => { note(`${label}: side step failed: ${err instanceof Error ? err.message : err}`); }) : Promise.resolve();
  const res = await job;
  await side;
  await sleep(1000);
  await monitor.stop();
  const summary = monitor.summary();
  const logLine = readFileSync(join(p.snapshots, 'backup.log'), 'utf8').trim().split('\n').filter((l) => / (OK|FAIL) /.test(l)).pop() || '';
  const stamp = /OK (\d{8}T\d{6}Z)/.exec(logLine)?.[1] ?? null;
  const restateAfter = docker('inspect', '-f', '{{.Id}}', `${SRC}-restate-1`);
  check(`${label}: nightly_backup.sh exits 0 with restate=paired_archive`, res.status === 0 && /restate=paired_archive/.test(logLine),
    `exit ${res.status} in ${(res.ms / 1000).toFixed(1)} s; ${logLine.replace(/sha256=[0-9a-f]+/, 'sha256=…').slice(0, 260)}${res.status ? `; ${res.stderr.slice(-600)}` : ''}`);
  check(`${label}: Restate restarted in place, not recreated`, restateBefore === restateAfter, `container ${restateBefore.slice(0, 12)} before and ${restateAfter.slice(0, 12)} after`);
  check(`${label}: intake is released and Restate healthy afterwards`, monitor.samples.at(-1)?.switchOn === true && monitor.samples.at(-1)?.restate === 'running/healthy',
    JSON.stringify(monitor.samples.at(-1)));
  if (!stamp) throw new Error(`${label}: no OK line in backup.log`);
  const pair = join(p.archive, `hawa_${stamp}.restate.json`);
  const pairFacts = JSON.parse(readFileSync(pair, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(p.archive, pairFacts.restateManifestName), 'utf8'));
  const verified = sh('python3', ['infra/backup/restate_nightly.py', '--verify-pair', pair], { env: { ...process.env, HAWA_BACKUP_ARCHIVE_KEYFILE: p.key }, allowFail: true });
  check(`${label}: restate_nightly.py --verify-pair re-reads and decrypts the three archived members`, verified.status === 0,
    verified.status === 0 ? verified.stdout.trim() : verified.stderr.slice(-300));
  const dumpToRestateGapSeconds = (Date.parse(manifest.capturedAt) - Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`)) / 1000;
  return {
    stamp, exit: res.status, nightlySeconds: res.ms / 1000, monitor: summary, pair: `hawa_${stamp}.restate.json`,
    restateManifest: pairFacts.restateManifestName,
    manifest: { capturedAt: manifest.capturedAt, serviceRecoveredAt: manifest.serviceRecoveredAt, runningInvocationsAtStop: manifest.runningInvocationsAtStop,
      regularFiles: manifest.regularFiles, encryptedBytes: manifest.encryptedBytes, restateImageId: manifest.restateImageId, nodeName: manifest.nodeName,
      volume: manifest.volume, composeSha256: manifest.composeSha256 },
    captureToRecoverySeconds: (Date.parse(manifest.serviceRecoveredAt) - Date.parse(manifest.capturedAt)) / 1000,
    dumpStampToRestateCaptureSeconds: dumpToRestateGapSeconds,
    logLine: logLine.replace(/sha256=[0-9a-f]+/, 'sha256=…'),
    restateContainerId: restateAfter.slice(0, 12),
  };
}

// ------------------------------------------------------------------------------------------------

async function sourceUp(p: Paths, commit: string) {
  writeFileSync(p.srcOverride, [
    '# R10 drill source: the file store is a host directory, as production\'s ~/.hawa/blobs is, and Restate',
    '# is health-checked at production\'s cadence.',
    'services:',
    '  restate:',
    `    environment: { RESTATE_NODE_NAME: ${NODE} }`,
    `    healthcheck: { interval: ${PROD_HEALTHCHECK.interval}, timeout: ${PROD_HEALTHCHECK.timeout}, retries: ${PROD_HEALTHCHECK.retries} }`,
    '  blob-init:',
    '    volumes: !override',
    `      - ${p.srcBlobs}:/var/lib/hawa/blobs`,
    '  core:',
    '    volumes: !override',
    '      - chaos_ca:/chaos-ca:ro',
    `      - ${p.srcBlobs}:/var/lib/hawa/blobs`,
    '',
  ].join('\n'));
  await configureStack({ project: SRC, ports: SRC_PORTS, imageTag: TAG, composeFiles: [p.srcOverride] });
  secrets();
  writeStackEnv(envFile(), SRC_PORTS, commit);
  up({ build: false, services: ['postgres', 'restate', 'fakes'] });
  await upgradeSchema();
  await connectCanva();
  await kaaeClientDna();
  up({ build: false, services: ['core', 'worker-blue'] });
  const reg = await registerColour('blue');
  if (reg.code !== 0) throw new Error(`register blue: ${reg.lines.join(' | ')}`);
  await fakes.reset();
}

async function officeRevision(chat: string): Promise<{ requestId: string; taskId: string }> {
  const [row] = await query<{ request_id: string; current_task_id: string; rev: string; stage: string }>(sql`
    SELECT request_id, current_task_id, rev, stage FROM hawa.requests WHERE chat_id = ${chat}`);
  if (row?.stage !== 'in_review') throw new Error(`chat ${chat} is not in office review`);
  const [task] = await query<{ revision_id: string }>(sql`SELECT current_design_revision_id AS revision_id FROM hawa.tasks WHERE id = ${row.current_task_id}::uuid`);
  const res = await fakes.core(`/tasks/${row.current_task_id}/revisions/${task.revision_id}/decisions`, secrets().CHAOS_REVIEWER_KEY, {
    headers: { 'Idempotency-Key': randomUUID() }, body: { action: 'revision_requested', revisionRequest: {
      scope: 'copy', category: 'factual_error', targetNodes: ['venue'], priority: 'high', isReusableFeedback: false,
      comment: 'Synthetic R10 drill revision: change the venue line.' } } });
  if (res.status !== 201) throw new Error(`office revision refused: HTTP ${res.status}`);
  return { requestId: row.request_id, taskId: row.current_task_id };
}

async function restoreDestination(p: Paths, night: Awaited<ReturnType<typeof nightly>>, images: Record<string, string>, pendingBefore: Invocation[], deploymentsBefore: string[]) {
  const t0 = Date.now();
  const t: Record<string, number> = {};
  const lap = (name: string) => { t[name] = (Date.now() - t0) / 1000; };
  const pair = join(p.archive, night.pair);
  const facts = JSON.parse(readFileSync(pair, 'utf8'));

  // 1. The pair, and the Restate archive against the source configuration it records.
  const verify = sh('python3', ['infra/backup/restate_nightly.py', '--verify-pair', pair], { env: { ...process.env, HAWA_BACKUP_ARCHIVE_KEYFILE: p.key } });
  const plan = sh('python3', ['infra/backup/restate_restore_rehearsal.py', '--pair', pair, '--key-file', p.key,
    '--compose-file', CHAOS_COMPOSE, '--source-volume', `${SRC}_chaos_restate`]);
  receipt.commands.push('[restore] python3 infra/backup/restate_nightly.py --verify-pair <archive>/' + night.pair,
    `[restore] python3 infra/backup/restate_restore_rehearsal.py --pair <pair> --key-file <key> --compose-file packages/testkit/chaos/docker-compose.chaos.yml --source-volume ${SRC}_chaos_restate`);
  check('restore: the paired night verifies on the clean host before anything is created', true, `${verify.stdout.trim()} | ${JSON.parse(plan.stdout).status}`);
  lap('pairVerified');

  // 2. The clean host's compose files: the recorded image IDs, only the roles script at PostgreSQL's
  // first start (the dump brings the schema), the restored Restate volume, and the surviving outside
  // world's trust anchor.
  mkdirSync(p.dstBlobs, { recursive: true, mode: 0o700 });
  writeFileSync(p.dstOverride, [
    '# R10 drill destination: a clean host restored from one paired night (ADR-134).',
    'services:',
    '  postgres:',
    `    image: "${images.postgres}"`,
    '    volumes: !override',
    '      - chaos_postgres:/var/lib/postgresql/data',
    `      - ${join(REPO_ROOT, 'infra/docker/00-init-roles.sql')}:/docker-entrypoint-initdb.d/00-init-roles.sql:ro`,
    '  restate:',
    `    image: "${night.manifest.restateImageId}"`,
    `    environment: { RESTATE_NODE_NAME: ${night.manifest.nodeName} }`,
    `    healthcheck: { interval: ${PROD_HEALTHCHECK.interval}, timeout: ${PROD_HEALTHCHECK.timeout}, retries: ${PROD_HEALTHCHECK.retries} }`,
    '  core:',
    `    image: "${images.core}"`,
    '    volumes: !override',
    '      - chaos_ca:/chaos-ca:ro',
    `      - ${p.dstBlobs}:/var/lib/hawa/blobs`,
    '  worker-blue:',
    `    image: "${images.worker}"`,
    'volumes:',
    `  chaos_ca: { external: true, name: ${SRC}_chaos_ca }`,
    `  chaos_restate: { external: true, name: ${RESTORED_RESTATE_VOLUME} }`,
    '',
  ].join('\n'));
  const srcEnv = envFile();
  await configureStack({ project: DST, ports: DST_PORTS, imageTag: TAG, composeFiles: [p.dstOverride] });
  // The approved secrets channel of a real clean host: the same credentials, injected.
  copyFileSync(srcEnv, envFile());
  chmodSync(envFile(), 0o600);
  writeStackEnv(envFile(), DST_PORTS, receipt.commit);

  // 3. PostgreSQL: the runbook's restore-swap block, as the file has it.
  compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres']);
  mkdirSync(p.restore, { recursive: true, mode: 0o700 });
  const dump = join(p.restore, 'hawa.dump');
  sh('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '100000', '-in', join(p.archive, facts.dumpName), '-out', dump, '-pass', `file:${p.key}`]);
  const runbook = readFileSync(join(REPO_ROOT, 'runbooks/10_backup_restore.md'), 'utf8');
  const block = /<!-- restore-swap:begin -->\n([\s\S]*?)<!-- restore-swap:end -->/.exec(runbook)?.[1]
    .split('\n').map((l) => l.replace(/^ {3}/, '')).filter((l) => !l.startsWith('```')).join('\n');
  if (!block) throw new Error('runbook has no restore-swap block');
  const swap = sh('bash', ['-Eeuo', 'pipefail', '-c', block], { env: { ...process.env, PG: `${DST}-postgres-1`, DB: 'hawa_chaos', DUMP: dump } });
  const replaced = /kept as (hawa_chaos_before_[0-9a-z]+)/.exec(swap.stdout)?.[1];
  check('restore: the runbook restore-swap block restores the paired dump (restore-check=ok)', /^restore-check=ok/m.test(swap.stdout) && !!replaced,
    swap.stdout.split('\n').filter((l) => /^(dump|new database|restore-check)/.test(l)).join(' | ').slice(0, 400));
  if (replaced) sh('docker', ['exec', `${DST}-postgres-1`, 'dropdb', '-U', 'hawa_owner', replaced]);
  rmSync(dump, { force: true });
  receipt.commands.push('[restore] openssl enc -d … hawa_<stamp>.dump.enc; runbooks/10_backup_restore.md restore-swap block with PG=hawa-chaos-r10d-postgres-1 DB=hawa_chaos');
  lap('postgresRestored');

  // 4. Files: every pack the night's manifest needs (blobs/index.tsv), unpacked as the runbook says.
  const wanted = readFileSync(join(p.archive, facts.blobManifestName), 'utf8').split('\n').filter(Boolean);
  const index = new Map(readFileSync(join(p.archive, 'blobs', 'index.tsv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]));
  const packs = [...new Set(wanted.map((w) => index.get(w)))];
  if (packs.some((x) => !x)) throw new Error('a file of the night is in no pack');
  for (const pack of packs as string[]) {
    sh('bash', ['-c', 'openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$1" -pass "file:$2" | tar -xkf - -C "$3"', 'unpack',
      join(p.archive, 'blobs', pack), p.key, p.dstBlobs]);
  }
  sh('bash', ['-c', 'find "$1/sha256" -type f -exec chmod 0444 {} + && find "$1" -type d -exec chmod 0755 {} +', 'perm', p.dstBlobs]);
  mkdirSync(join(p.dstBlobs, 'tmp'), { recursive: true });
  writeFileSync(join(p.dstBlobs, '.hawa-blob-store'), 'sha256-v1\n');
  // Compose checks every volume of the project, the restored Restate volume included, before it runs anything.
  docker('volume', 'create', '--label', `hawa.r10-drill=${DST}`, guardName(RESTORED_RESTATE_VOLUME));
  // The owner URL reaches the one-off container through compose's environment, never its arguments.
  process.env.DATABASE_URL = `postgresql://hawa_owner:${secrets().CHAOS_OWNER_PASSWORD}@postgres:5432/hawa_chaos`;
  let verifyBlobs: ReturnType<typeof compose>;
  try {
    verifyBlobs = compose(['run', '--rm', '--no-deps', '-T', '-e', 'DATABASE_URL',
      'core', 'node', '/app/apps/core/dist/tools/blob-verify.js', '--dir', '/var/lib/hawa/blobs']);
  } finally {
    delete process.env.DATABASE_URL;
  }
  const blobLine = verifyBlobs.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}';
  const blobReport = JSON.parse(blobLine);
  check('restore: every registered file is back with its exact bytes (blob-verify missing = 0)', blobReport.missing === 0 && wanted.length > 0,
    `${wanted.length} files in the night's manifest from ${packs.length} pack(s); blob-verify ${JSON.stringify(blobReport).slice(0, 200)}`);
  receipt.commands.push('[restore] openssl enc -d … blobs/<pack> | tar -xkf - (runbook step 4); blob-verify.js --dir (runbook step 5, in the pinned Core image)');
  lap('filesRestored');

  // 5. Restate: one archive into the new (still empty) volume, verified member by member; no other node may run.
  const restored = sh('python3', ['infra/backup/restate_restore_rehearsal.py', '--pair', pair, '--key-file', p.key,
    '--compose-file', CHAOS_COMPOSE, '--source-volume', `${SRC}_chaos_restate`, '--restore-into', RESTORED_RESTATE_VOLUME]);
  const restoredFacts = JSON.parse(restored.stdout);
  check('restore: restate_restore_rehearsal.py --restore-into fills the new volume with exactly the archive', restoredFacts.identicalToArchive === true,
    `${restoredFacts.regularFiles} files, node ${restoredFacts.nodeName}, image ${String(restoredFacts.imageId).slice(0, 19)}`);
  receipt.commands.push(`[restore] python3 infra/backup/restate_restore_rehearsal.py … --restore-into ${RESTORED_RESTATE_VOLUME}`);
  compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'restate']);
  lap('restateStarted');
  const nodes = docker('ps', '--filter', `ancestor=${night.manifest.restateImageId}`, '--format', '{{.Names}}').split('\n').filter(Boolean)
    .filter((name) => JSON.parse(docker('inspect', '--format', '{{json .Config.Env}}', name)).includes(`RESTATE_NODE_NAME=${NODE}`));
  check('restore: exactly one Restate node with the archived node name runs on this Docker host', nodes.length === 1 && nodes[0] === `${DST}-restate-1`,
    `running: ${JSON.stringify(nodes)}`);
  const pendingAfter = await waitUntil('the restored journal to answer', async () => (await openInvocations()), 60_000, 1000);
  const before = pendingBefore.map((i) => i.id).sort();
  const after = pendingAfter.map((i) => i.id).sort();
  check('restore: the restored node holds the same unfinished invocations, before any writer starts', JSON.stringify(before) === JSON.stringify(after),
    `${before.length} before the capture, ${after.length} restored: ${pendingAfter.map((i) => `${i.target_service_name}.${i.target_handler_name}:${i.status}`).join(', ')}`);
  const deploymentsAfter = await restateDeployments();
  check('restore: the worker deployment registered on the source is the one the restored node knows (no re-registration)',
    JSON.stringify(deploymentsAfter) === JSON.stringify(deploymentsBefore), `${deploymentsAfter.length} deployment(s)`);

  // 6. The outside world reaches the new host under the provider names, then one Core and one worker.
  const aliases = ['fakes', 'api.telegram.org', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com', 'api.canva.com',
    'export-download.canva.com', 'document-export.canva.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com'];
  sh('docker', ['network', 'connect', ...aliases.flatMap((a) => ['--alias', a]), guardName(`${DST}_chaos`), guardName(`${SRC}-fakes-1`)]);
  compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'core']);
  compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'worker-blue']);
  lap('stackReady');
  const workers = docker('ps', '--filter', `label=com.docker.compose.service=worker-blue`, '--filter', 'status=running', '--format', '{{.Names}}').split('\n').filter((n) => n.startsWith('hawa-chaos-r10'));
  const greens = docker('ps', '-a', '--filter', `name=^${DST}-worker-green-1$`, '--format', '{{.Names}}');
  check('restore: one worker runs for the restored node (no second colour, the source worker is gone)', workers.length === 1 && workers[0] === `${DST}-worker-blue-1` && !greens,
    JSON.stringify(workers));
  const dstImages = Object.fromEntries(['postgres', 'restate', 'core', 'worker-blue'].map((s) => [s, docker('inspect', '-f', '{{.Image}}', `${DST}-${s}-1`)]));
  check('restore: the clean host runs the recorded image IDs', dstImages.core === images.core && dstImages['worker-blue'] === images.worker &&
    dstImages.restate === night.manifest.restateImageId && dstImages.postgres === images.postgres, JSON.stringify(dstImages));
  const mounts = ['postgres', 'restate', 'core'].flatMap((s) => JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', `${DST}-${s}-1`)) as any[])
    .map((m) => m.Name || m.Source);
  check('restore: no store of the source host is mounted on the clean host', !mounts.some((m) => /hawa-chaos-r10s_chaos_(postgres|restate)|src-blobs/.test(String(m))),
    mounts.map((m) => String(m).replace(p.root, '<scratch>')).join(', '));
  return { timings: t, startedAt: iso(t0), pendingAfterRestore: pendingAfter, dstImages };
}

async function restateDeployments(): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${PORTS.restateAdmin}/deployments`);
  const body = await res.json() as { deployments: Array<{ id: string }> };
  return body.deployments.map((d) => d.id).sort();
}

// ------------------------------------------------------------------------------------------------

async function teardown(p: Paths | null): Promise<void> {
  await closeDb();
  for (const [project, ports] of [[DST, DST_PORTS], [SRC, SRC_PORTS]] as const) {
    const override = p ? (project === SRC ? p.srcOverride : p.dstOverride) : null;
    await configureStack({ project, ports, imageTag: TAG, composeFiles: override && existsSync(override) ? [override] : [] });
    if (!existsSync(envFile())) { secrets(); writeStackEnv(envFile(), ports, 'teardown'); }
    compose(['--profile', 'green', '--profile', 'candidate', 'down', '--remove-orphans', '-v'], { allowFail: true });
    rmSync(envFile(), { force: true });
  }
  const leftovers = [
    ...docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${SRC}`).split('\n'),
    ...docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${DST}`).split('\n'),
  ].filter(Boolean);
  for (const id of leftovers) sh('docker', ['rm', '-f', id], { allowFail: true });
  for (const volume of docker('volume', 'ls', '-q').split('\n').filter((v) => v.startsWith(`${SRC}_`) || v.startsWith(`${DST}_`) || v === RESTORED_RESTATE_VOLUME)) {
    sh('docker', ['volume', 'rm', '-f', guardName(volume)], { allowFail: true });
  }
  for (const network of docker('network', 'ls', '--format', '{{.Name}}').split('\n').filter((n) => n.startsWith(`${SRC}_`) || n.startsWith(`${DST}_`))) {
    sh('docker', ['network', 'rm', guardName(network)], { allowFail: true });
  }
  if (p) rmSync(p.root, { recursive: true, force: true });
}

async function main(): Promise<void> {
  if (process.argv.includes('--down')) {
    await teardown(process.env.HAWA_R10_SCRATCH ? paths(scratchRoot()) : null);
    console.log('[r10] both drill projects, their volumes, networks and the scratch directory are gone');
    return;
  }
  const p = paths(scratchRoot());
  if (existsSync(p.root) && readdirSync(p.root).length) throw new Error('HAWA_R10_SCRATCH must be empty');
  for (const project of [SRC, DST]) {
    if (docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`)) throw new Error(`${project} already has containers; run --down first`);
  }
  for (const dir of [p.root, p.archive, p.snapshots, p.logs, p.srcBlobs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A throwaway archive key: never printed, never the office's, deleted with the scratch directory.
  writeFileSync(p.key, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  const commit = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  receipt.commit = commit;
  process.env.CHAOS_BUILD_COMMIT = commit;
  const images = { core: imageId(`hawa-chaos-core:${TAG}`), worker: imageId(`hawa-chaos-worker:${TAG}`), fakes: imageId(`hawa-chaos-fakes:${TAG}`),
    restate: imageId(RESTATE_TAG), postgres: imageId('pgvector/pgvector:pg17') };
  receipt.images = { ...images, helper: helperImage(),
    buildCommits: Object.fromEntries(['core', 'worker'].map((s) => [s, docker('image', 'inspect', `hawa-chaos-${s}:${TAG}`, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}')])) };
  const keep = process.env.HAWA_R10_KEEP === '1';
  try {
    note(`source ${SRC} up`);
    await sourceUp(p, commit);
    const ledgerStart = await effects();

    // Chat A: a request waiting for the office's decision (RequestLifecycle state in_review).
    const taskA = await briefToDraft(CHAT.A, 'R10.A');
    note(`chat A: task ${taskA} in office review`);

    // Night 1 on a live stack; a brief is queued in Telegram while Restate is stopped.
    let queuedE: { id: number; at: number } | null = null;
    const night1 = await nightly(p, 'night 1', 300, async (m, finished) => {
      await waitUntil('Restate to stop for the capture', async () => {
        if (finished()) throw new RequestEndedError('the nightly ended before Restate was seen stopped');
        return m.samples.some((s) => s.switchOn === false && !s.restate.startsWith('running'));
      }, 300_000, 100);
      const [id] = await fakes.updates([textUpdate(CHAT.E, briefText('R10.E'))]);
      queuedE = { id, at: Date.now() };
    });
    receipt.night1 = night1;
    if (!queuedE) throw new Error('the brief for chat E was never queued');
    const e = queuedE as { id: number; at: number };
    const taskE = await waitUntil(`chat E's task`, async () => (await tasksOfChat(CHAT.E))[0]?.id, 180_000, 1000);
    await waitUntil(`chat E's draft`, async () => {
      const [r] = await query<{ stage: string }>(sql`SELECT stage FROM hawa.requests WHERE chat_id = ${CHAT.E}`);
      return r?.stage === 'in_review';
    }, 240_000, 2000);
    const polls = (await fakes.polls()) as { polls?: Array<{ at: string; offset: number; returned: number[] }> } | Array<{ at: string; offset: number; returned: number[] }>;
    const pollList = Array.isArray(polls) ? polls : polls.polls ?? [];
    // Telegram may answer a long poll that was already open when the switch was thrown; the poller
    // then hands nothing on and keeps its offset, so the update is offered again after the release.
    const returnedAt = pollList.filter((x) => x.returned.includes(e.id)).map((x) => x.at);
    const releasedAt = night1.monitor.intakeReleasedAt;
    const pollsDuringPause = pollList.filter((x) => night1.monitor.intakePausedAt && releasedAt && x.at > night1.monitor.intakePausedAt && x.at < releasedAt).length;
    const inboxE = await restateQuery<{ status: string; created_at: string }>(`SELECT status, created_at FROM sys_invocation WHERE target_service_name = 'ChatInbox' AND idempotency_key = 'tg-${e.id}'`);
    const handedOnAt = inboxE[0]?.created_at ?? null;
    // The poller reads the switch at most every 5 s, so it may hand an update on in the first seconds of a
    // pause; an update Restate cannot take yet stays unconfirmed in Telegram and is asked for again.
    check('night 1: a brief sent while Restate was stopped for the capture is not lost and is handed on once',
      !!handedOnAt && Date.parse(handedOnAt) >= e.at && inboxE.length === 1 && inboxE[0].status === 'completed' && (await tasksOfChat(CHAT.E)).length === 1,
      `queued ${iso(e.at)}; intake released ${releasedAt}; returned by getUpdates at ${returnedAt.join(', ')}; handed to ChatInbox ${handedOnAt}; ${pollsDuringPause} getUpdates calls during the pause; ChatInbox ${JSON.stringify(inboxE.map((i) => i.status))}; task ${taskE}`);
    receipt.pauseUpdate = { queuedAt: iso(e.at), returnedByGetUpdatesAt: returnedAt, handedToChatInboxAt: handedOnAt, releasedAt,
      getUpdatesCallsDuringPause: pollsDuringPause, secondsFromQueueToHandOn: handedOnAt ? (Date.parse(handedOnAt) - e.at) / 1000 : null };

    // In-flight work for night 2.
    const taskB = await briefToDraft(CHAT.B, 'R10.B');
    // Every notice to chat B is refused with a long retry_after until the source host is gone.
    await fakes.telegramFault({ method: 'sendMessage', chat: CHAT.B, kind: '429', retryAfter: 600, n: 1000 });
    const revision = await officeRevision(CHAT.B);
    await waitUntil('chat B at rev 3 waiting for the requester', async () => {
      const [r] = await query<{ rev: string; stage: string }>(sql`SELECT rev, stage FROM hawa.requests WHERE request_id = ${revision.requestId}::uuid`);
      return r?.stage === 'manual' && Number(r.rev) === 3;
    }, 120_000, 500);
    await waitUntil('the revision notice to meet Telegram 429', async () => (await fakes.sent()).some((s) => s.chat_id === CHAT.B && s.fault === '429'), 120_000, 500);
    note(`chat B: task ${taskB} office revision recorded; its notice is held by Telegram 429`);
    await fakes.hold('core.intake.after-decision', { chat: CHAT.C });
    const briefC = await sendBrief(CHAT.C, 'R10.C');
    const heldC = await fakes.wait('core.intake.after-decision', 120_000);
    if (!heldC?.held) throw new Error('chat C never reached Core intake');
    note(`chat C: update ${briefC.update_id} held in Core intake after its decision`);
    // Freeze the source worker: nothing it would do after the capture can reach the outside world.
    sh('docker', ['pause', guardName(`${SRC}-worker-blue-1`)]);
    await sleep(2000);
    const pendingBefore = await openInvocations();
    const deploymentsBefore = await restateDeployments();
    const reminder = pendingBefore.find((i) => i.target_service_name === 'RequestLifecycle' && i.target_handler_name === 'reminderTick');
    const sender = pendingBefore.find((i) => i.target_service_name === 'TelegramSender' && i.target_service_key === CHAT.B);
    const inboxC = pendingBefore.find((i) => i.target_service_name === 'ChatInbox' && i.target_service_key === CHAT.C);
    const reminderTimesBefore = reminder ? await invocationTimes(reminder.id) : {};
    check('in flight at the capture: a RequestLifecycle waiting for the office (chat A), a 24-hour reminder timer, a TelegramSender holding a refused notice, a running ChatInbox',
      !!reminder && !!sender && !!inboxC && (await query<{ stage: string }>(sql`SELECT stage FROM hawa.requests WHERE chat_id = ${CHAT.A}`))[0]?.stage === 'in_review',
      pendingBefore.map((i) => `${i.target_service_name}.${i.target_handler_name}[${i.target_service_key}]:${i.status}`).join(', '));
    const atCapture = await effects();
    receipt.inFlight = { pendingBefore, reminder, sender, inboxC, deploymentsBefore,
      requests: await query(sql`SELECT chat_id, stage, rev FROM hawa.requests WHERE chat_id IN (${CHAT.A}, ${CHAT.B}, ${CHAT.C}, ${CHAT.E}) ORDER BY chat_id`) };

    const night2 = await nightly(p, 'night 2', 30);
    receipt.night2 = night2;
    const afterNight2 = await effects();
    check('nothing left the source host between the capture and its loss', JSON.stringify(afterNight2) === JSON.stringify(atCapture),
      `at capture ${JSON.stringify(atCapture)}; after night 2 ${JSON.stringify(afterNight2)}`);

    // The source host is lost: its stores and processes go; the outside world (fakes) stays.
    await closeDb();
    const lostAt = Date.now();
    for (const s of ['worker-blue', 'core', 'restate', 'postgres', 'blob-init']) sh('docker', ['rm', '-f', guardName(`${SRC}-${s}-1`)], { allowFail: true });
    for (const v of ['chaos_postgres', 'chaos_restate', 'chaos_blobs']) sh('docker', ['volume', 'rm', '-f', guardName(`${SRC}_${v}`)], { allowFail: true });
    rmSync(p.srcBlobs, { recursive: true, force: true });
    await fakes.clearFaults();
    note('source host lost: its Postgres, Restate, Core and worker containers and their volumes are removed; the fakes survive');

    const restored = await restoreDestination(p, night2, images, pendingBefore, deploymentsBefore);
    receipt.restore = { ...restored, secondsFromLossToRestoreStart: (Date.parse(restored.startedAt) - lostAt) / 1000 };

    // Resume: every unfinished invocation must finish (the reminder stays scheduled for its day).
    const resumeStart = Date.now();
    const finished = await waitUntil('the restored invocations to finish', async () => {
      const rows = await restateQuery<Invocation>(`SELECT id, target_service_name, target_handler_name, status, scheduled_start_at, last_failure_error_code
        FROM sys_invocation WHERE id IN (${pendingBefore.map((i) => `'${i.id}'`).join(',')})`);
      const open = rows.filter((r) => r.status !== 'completed' && r.id !== reminder!.id);
      return open.length === 0 ? rows : null;
    }, 300_000, 1000);
    receipt.timings.resumedAllSeconds = (Date.now() - resumeStart) / 1000;
    const reminderAfter = finished.find((r) => r.id === reminder!.id);
    const reminderTimesAfter = await invocationTimes(reminder!.id);
    receipt.reminderTimes = { atCapture: reminderTimesBefore, afterRestore: reminderTimesAfter };
    check('resume: every invocation in flight at the capture finished on the clean host', finished.filter((r) => r.id !== reminder!.id).every((r) => r.status === 'completed'),
      finished.map((r) => `${r.id.slice(0, 12)} ${r.target_service_name}.${r.target_handler_name}:${r.status}`).join(', '));
    check('resume: the 24-hour reminder is still scheduled for the same moment (not lost, not fired early)',
      !!reminderAfter && reminderAfter.status === 'scheduled' && !!reminderTimesBefore.scheduled_start_at &&
        Date.parse(reminderTimesBefore.scheduled_start_at) > Date.now() + 23 * 3600_000 &&
        reminderTimesAfter.scheduled_start_at === reminderTimesBefore.scheduled_start_at && reminderTimesAfter.created_at === reminderTimesBefore.created_at,
      `before ${reminder!.status} due ${reminderTimesBefore.scheduled_start_at}; after ${reminderAfter?.status} due ${reminderTimesAfter.scheduled_start_at}`);

    // Chat B: the held notice reached the requester exactly once.
    const noticeB = await waitUntil('chat B revision notice', async () => {
      const [mark] = await query<{ outcome: string }>(sql`SELECT payload->>'outcome' AS outcome FROM hawa.inbox_events
        WHERE source_account_id = 'telegram_delivery' AND source_event_id = ${`lc:${revision.requestId}:3:office-revision-notify:send`}
        ORDER BY received_at DESC LIMIT 1`);
      return mark?.outcome === 'sent' ? mark : null;
    }, 180_000, 1000);
    const bSent = (await sentTo(CHAT.B)).filter((s) => s.method === 'sendMessage');
    check('chat B: the notice Telegram refused before the capture is sent once after the restore', noticeB.outcome === 'sent' && new Set(bSent.map((s) => s.textHash)).size === bSent.length,
      `${bSent.length} messages in chat B, all distinct`);

    // Chat C: the running ChatInbox resumes; Core answers its replay as the duplicate it is.
    const tasksC = await waitUntil('chat C to reach office review', async () => {
      const [r] = await query<{ stage: string }>(sql`SELECT stage FROM hawa.requests WHERE chat_id = ${CHAT.C}`);
      return r?.stage === 'in_review' ? await tasksOfChat(CHAT.C) : null;
    }, 300_000, 2000);
    const inboxAfter = await restateQuery<{ status: string }>(`SELECT status FROM sys_invocation WHERE target_service_name = 'ChatInbox' AND target_handler_name = 'handleUpdate' AND target_service_key = '${CHAT.C}'`);
    check('chat C: the ChatInbox running at the capture completes once, one task, and its design reaches office review',
      tasksC.length === 1 && inboxAfter.length === 1 && inboxAfter[0].status === 'completed', `tasks=${tasksC.length}; ChatInbox ${JSON.stringify(inboxAfter)}`);

    // Chat A: the office approves on the clean host; the Delivery workflow sends both files once.
    const approved = await approve(taskA, { pinDeck: true });
    if (approved.status >= 300) throw new Error(`approval refused: HTTP ${approved.status}`);
    const delivered = await deliver(taskA);
    if ((delivered.status !== 202 && delivered.status !== 200) || delivered.body?.executor !== 'restate') throw new Error(`deliver: HTTP ${delivered.status}`);
    await waitDelivered(CHAT.A, taskA, 300_000, 2);
    const aChecks = await checkRequest(CHAT.A, { delivered: true, files: 2, executor: 'restate', ledgerSince: 0 });
    for (const c of aChecks) check(`chat A: ${c.name}`, c.ok, c.detail);

    const dupes = await duplicateSends();
    check('no Telegram message, file or notice reached any chat twice (source and clean host together)', dupes.length === 0, dupes.join(', ') || 'none');
    const twice = await paidCallsTwice();
    check('no paid model call ran twice', twice.length === 0, twice.join(', ') || 'none');
    const canvaTwice = await query<{ task_id: string; n: string }>(sql`SELECT task_id, count(*) AS n FROM hawa.canva_remote_operations WHERE kind = 'create' GROUP BY task_id HAVING count(*) > 1`);
    check('one Canva import per task', canvaTwice.length === 0, `${canvaTwice.length} tasks with more than one import`);
    const [paused] = await restateQuery<{ n: number }>(`SELECT count(*) AS n FROM sys_invocation WHERE status = 'paused' OR last_failure_error_code = 'RT0016'`);
    check('no paused invocation and no journal mismatch on the clean host', Number(paused?.n ?? 0) === 0, `paused or RT0016: ${paused?.n ?? 0}`);
    const alerts = (await sentTo(OFFICE_CHAT)).filter((s) => s.text && !s.text.startsWith('A design is ready for office review in Hawa Desk.'));
    check('no office alert (no send became uncertain)', alerts.length === 0, `${alerts.length} alerts`);
    const final = await effects();
    receipt.effects = { atDrillStart: ledgerStart, atCapture, afterNight2, final };
    receipt.requestsFinal = await query(sql`SELECT chat_id, stage, rev FROM hawa.requests WHERE chat_id IN (${CHAT.A}, ${CHAT.B}, ${CHAT.C}, ${CHAT.E}) ORDER BY chat_id`);
  } catch (err) {
    receipt.error = err instanceof Error ? err.message : String(err);
    receipt.error = scrub(String(receipt.error));
    console.error(`[r10] ERROR ${receipt.error}`);
  } finally {
    receipt.finishedAt = new Date().toISOString();
    receipt.checks = checks;
    receipt.passed = !receipt.error && checks.length > 0 && checks.every((c) => c.ok);
    receipt.scriptSha256 = sha256File(join(CHAOS_DIR, 'r10-restore.ts'));
    const text = scrub(JSON.stringify(receipt, null, 2).split(p.root).join('<scratch>'));
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(RECEIPT, text + '\n', { mode: 0o600 });
    console.log(`[r10] ${receipt.passed ? 'PASSED' : 'FAILED'}: ${checks.filter((c) => c.ok).length}/${checks.length} checks; receipt ${relative(REPO_ROOT, RECEIPT)}`);
    if (!keep) await teardown(p);
    else { await closeDb(); console.log('[r10] HAWA_R10_KEEP=1: both projects are still up; remove them with --down'); }
  }
  process.exit(receipt.passed ? 0 : 1);
}

void main().catch((err) => { console.error(err); process.exit(1); });

