/**
 * The restore drill's hold on the hawa-chaos stack (architecture programme 2.6, ADR-034,
 * PHASE2_DESIGN.md section 2.6): the nightly Restate backup and the restore run as the office runs
 * them, with the scripts from infra/backup pointed at this project's containers instead of
 * production's. Every file they write (the archive, its passphrase, the backup log and state) stays
 * in .run/restore-drill (gitignored); no alert can be sent, because the operator's env file is
 * pointed at a file that does not exist.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAOS_DIR, PROJECT, REPO_ROOT, fakes, secrets } from './stack.js';

export const DRILL_DIR = join(CHAOS_DIR, '.run', 'restore-drill');
const paths = {
  archive: join(DRILL_DIR, 'archive'),
  snapshots: join(DRILL_DIR, 'snapshots'),
  keyfile: join(DRILL_DIR, 'passphrase'),
  state: join(DRILL_DIR, 'restate-backup.state'),
};

/** A clean drill folder with a throwaway passphrase (never printed). */
export function prepareDrill(): void {
  rmSync(DRILL_DIR, { recursive: true, force: true });
  for (const d of [paths.archive, paths.snapshots]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(paths.keyfile, randomBytes(32).toString('hex'), { mode: 0o600 });
}

function drillEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  if (!PROJECT.startsWith('hawa-chaos')) throw new Error(`refusing to run the drill against ${PROJECT}`);
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    HAWA_RESTATE_PROJECT: PROJECT,
    // Core listens on 3001 inside its container here (docker-compose.chaos.yml), as in production.
    HAWA_RESTATE_CORE_URL: 'http://127.0.0.1:3001',
    HAWA_RESTATE_CORE_AUTH_VAR: 'HAWA_BEARER_TOKEN',
    HAWA_RESTATE_BACKUP_STATE: paths.state,
    HAWA_BACKUP_SNAPSHOT_DIR: paths.snapshots,
    HAWA_BACKUP_ARCHIVE_DEST: paths.archive,
    HAWA_BACKUP_ARCHIVE_KEYFILE: paths.keyfile,
    HAWA_BACKUP_ARCHIVE_KEEP: '3',
    // No alert can leave: the file the scripts read the bot token from does not exist.
    HAWA_BACKUP_NOTIFY_ENV: join(DRILL_DIR, 'no-operator-env'),
    ...extra,
  };
}

export interface ScriptRun {
  code: number | null;
  ms: number;
  out: string;
}

function runScript(script: string, env: NodeJS.ProcessEnv, timeoutMs: number): { child: ReturnType<typeof spawn>; done: Promise<ScriptRun> } {
  const started = Date.now();
  const child = spawn('bash', [join(REPO_ROOT, script)], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (b) => (out += b));
  child.stderr!.on('data', (b) => (out += b));
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const done = new Promise<ScriptRun>((resolve) => child.on('exit', (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - started, out }); }));
  return { child, done };
}

/** infra/backup/restate-nightly.sh against this stack; resolves when it has finished. */
export function startBackup(extra: Record<string, string> = {}) {
  return runScript('infra/backup/restate-nightly.sh', drillEnv(extra), 20 * 60_000).done;
}

/** infra/backup/restate-restore.sh into this stack's Restate, from the drill's newest archive. */
export function restore(archive?: string) {
  return runScript('infra/backup/restate-restore.sh', drillEnv({ HAWA_RESTATE_RESTORE_PROJECT: PROJECT, ...(archive ? { HAWA_RESTATE_RESTORE_ARCHIVE: archive } : {}) }), 20 * 60_000).done;
}

/** The drill's backup log (the RESTATE lines the nightly job would write). */
export function backupLog(): string[] {
  const f = join(paths.snapshots, 'backup.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
}

export function archives(): string[] {
  return existsSync(paths.archive) ? readdirSync(paths.archive).filter((n) => /^restate_\d{8}T\d{6}Z\.tar(\.enc)?$/.test(n)).sort() : [];
}
export function archivePath(name: string): string {
  return join(paths.archive, name);
}

/** The Telegram kill switch as Core reports it: true while intake is switched off. */
export async function intakeSwitchedOff(): Promise<boolean | null> {
  const res = await fakes.core('/ingress/status', secrets().CHAOS_BEARER_TOKEN);
  const on = res.json?.channels?.telegram;
  return typeof on === 'boolean' ? !on : null;
}

/** A `key=value` field of a log line. */
export function field(line: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(line)?.[1];
}
