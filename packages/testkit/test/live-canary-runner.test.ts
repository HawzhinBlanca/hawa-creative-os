import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-240: infra/ops/live_canary.sh, the nightly runner of the live canary. It runs only on the
 * production host, never during a deploy (the deploy lock), never on a loaded host, after the nightly
 * backup, and only once configured; a failed night, and a second skipped night in a row, reach the
 * operator through the watchdog's own alert path (watchdog.sh --notify). The canary itself is replaced by
 * HAWA_CANARY_RUN; uptime, pgrep, sleep and curl are stubs first on PATH.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const runner = path.join(repo, 'infra/ops/live_canary.sh');
const lock = path.join(repo, 'infra/ops/deploy_lock.py');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-live-canary-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const CANARY = String(2 ** 52 + 5);

let n = 0;
function setup(opts: { load?: string; backupRuns?: number; configured?: boolean; role?: string } = {}) {
  const t = path.join(tmp, `case-${++n}`);
  const bin = path.join(t, 'bin'), home = path.join(t, 'home'), out = path.join(t, 'canary');
  for (const d of [bin, path.join(home, '.hawa')]) fs.mkdirSync(d, { recursive: true });
  const f = (name: string) => path.join(t, name);
  if (opts.role) fs.writeFileSync(path.join(home, '.hawa', 'host-role'), `${opts.role}\n`);
  fs.writeFileSync(f('env.production'), [
    'TELEGRAM_BOT_TOKEN=test-token', 'TELEGRAM_ALLOWED_USERS=7000001,7000002',
    ...(opts.configured === false ? [] : [`HAWA_CANARY_CHAT_ID=${CANARY}`, 'HAWA_CANARY_CLIENT_ID=5e1f0000-0000-4000-8000-0000000000aa',
      'HAWA_CANARY_CLIENT_NAME=CANARY']), ''].join('\n'));
  fs.writeFileSync(f('backup-runs'), String(opts.backupRuns ?? 0));
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('uptime', `echo " 3:30  up 2 days, 4 users, load averages: ${opts.load ?? '1.52'} 1.40 1.31"`);
  stub('pgrep', `left=$(cat '${f('backup-runs')}'); if (( left > 0 )); then echo $((left - 1)) > '${f('backup-runs')}'; echo 4242; exit 0; fi; exit 1`);
  // Waits of the backup loop pass at once; the run's own time limit is a real sleep.
  stub('sleep', `echo "sleep $*" >> '${f('sleeps')}'; if (( \${1%.*} >= 600 )); then exec /bin/sleep "$@"; fi; exit 0`);
  stub('curl', `printf '%s\\n' "$*" >> '${f('curl')}'`);
  const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, HAWA_CURRENT_LINK: path.join(t, 'no-release'),
    HAWA_CANARY_ENV_FILE: f('env.production'), HAWA_WATCHDOG_ENV_FILE: f('env.production'), HAWA_CANARY_OUT_DIR: out,
    HAWA_DEPLOY_LOCK: f('deploy.lock'), HAWA_CANARY_AFTER_BACKUP_SECONDS: '0', HAWA_CANARY_STAMP: '20261002T003000Z' };
  const run = (canary: string, extra: Record<string, string> = {}) =>
    spawnSync(BASH, [runner], { encoding: 'utf8', env: { ...env, HAWA_CANARY_RUN: canary, ...extra }, timeout: 60_000 });
  const read = (name: string) => (fs.existsSync(f(name)) ? fs.readFileSync(f(name), 'utf8') : '');
  const latest = () => JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
  return { t, f, env, out, run, read, latest };
}

describe('the nightly canary runner (ADR-240)', () => {
  it('runs the canary with its settings from .env.production, and tells nobody when it passes', () => {
    const s = setup();
    const res = s.run(`env | grep '^HAWA_CANARY_C' | sort > '${path.join(tmp, 'case-1', 'seen')}'; exit 0`);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(s.read('seen')).toBe([`HAWA_CANARY_CHAT_ID=${CANARY}`, 'HAWA_CANARY_CLIENT_ID=5e1f0000-0000-4000-8000-0000000000aa',
      'HAWA_CANARY_CLIENT_NAME=CANARY', ''].join('\n'));
    expect(res.stdout).toContain('passed');
    expect(s.read('curl')).toBe('');
  });

  it('a failed night reaches the operator through the watchdog\'s alert path, with the canary\'s summary', () => {
    const s = setup();
    const res = s.run(`printf 'Hawa nightly canary FAILED (stub night)\\nFAIL cancel · a cancel with a reason withdraws the design: stage manual\\n' > "${'$'}HAWA_CANARY_OUT_DIR/20261002T003000Z.txt"; exit 1`);
    expect(res.status).toBe(1);
    const curl = s.read('curl');
    expect(curl).toContain('https://api.telegram.org/bottest-token/sendMessage');
    expect(curl).toContain('chat_id=7000001');
    expect(curl).toContain('Hawa nightly canary failed');
    expect(curl).toContain('a cancel with a reason withdraws the design');
  });

  it('a run that ends without a result is a failed night too', () => {
    const s = setup();
    const res = s.run('exit 2');
    expect(res.status).toBe(1);
    expect(s.read('curl')).toContain('it stopped (exit 2) before writing a result');
  });

  it('skips the night while a deploy holds the deploy lock, and starts nothing', async () => {
    const s = setup();
    const holder = spawn('python3', [lock, '--lock', s.f('deploy.lock'), '--', '/bin/sleep', '5']);
    await new Promise((r) => setTimeout(r, 700));
    const res = s.run(`touch '${s.f('ran')}'`);
    holder.kill();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(s.f('ran'))).toBe(false);
    expect(s.latest()).toMatchObject({ status: 'skipped', reason: 'a deploy holds the deploy lock' });
  });

  it('holds the deploy lock while it runs, so a deploy that starts meanwhile waits for it', async () => {
    const s = setup();
    const run = spawn(BASH, [runner], { env: { ...s.env, HAWA_CANARY_RUN: '/bin/sleep 3' } });
    await new Promise((r) => setTimeout(r, 1000));
    const deploy = spawnSync('python3', [lock, '--lock', s.f('deploy.lock'), '--', 'true'], { encoding: 'utf8' });
    expect(deploy.status).toBe(75);
    expect(deploy.stderr).toContain('a deploy or the nightly canary is running');
    await new Promise((r) => run.on('exit', r));
    expect(spawnSync('python3', [lock, '--lock', s.f('deploy.lock'), '--', 'true']).status).toBe(0);
  });

  it('skips the night when the load average is above 10', () => {
    const s = setup({ load: '12.75' });
    const res = s.run(`touch '${s.f('ran')}'`);
    expect(res.status).toBe(0);
    expect(fs.existsSync(s.f('ran'))).toBe(false);
    expect(s.latest()).toMatchObject({ status: 'skipped', reason: 'the load average is 12.75, above 10' });
  });

  it('waits for the nightly backup to finish, and skips the night when it does not', () => {
    const waited = setup({ backupRuns: 2 });
    expect(waited.run(`touch '${waited.f('ran')}'`).status).toBe(0);
    expect(fs.existsSync(waited.f('ran'))).toBe(true);
    expect(waited.read('sleeps')).toContain('sleep 30\nsleep 30\n');
    const stuck = setup({ backupRuns: 5 });
    expect(stuck.run(`touch '${stuck.f('ran')}'`, { HAWA_CANARY_BACKUP_WAIT: '60' }).status).toBe(0);
    expect(fs.existsSync(stuck.f('ran'))).toBe(false);
    expect(stuck.latest()).toMatchObject({ status: 'skipped', reason: 'the nightly backup was still running after 60 s' });
  });

  it('is quiet until configured, and off a production host', () => {
    const unset = setup({ configured: false });
    expect(unset.run(`touch '${unset.f('ran')}'`).status).toBe(0);
    expect(unset.latest().reason).toMatch(/HAWA_CANARY_CHAT_ID is not set/);
    expect(unset.run('exit 0').status).toBe(0);
    expect(unset.read('curl')).toBe('');
    const standby = setup({ role: 'standby' });
    expect(standby.run(`touch '${standby.f('ran')}'`).status).toBe(0);
    expect(fs.existsSync(standby.f('ran'))).toBe(false);
    expect(standby.latest().reason).toBe('this host is standby, not production');
  });

  it('alerts the operator when it has skipped two nights in a row', () => {
    const s = setup({ load: '15' });
    s.run('exit 0');
    expect(s.read('curl')).toBe('');
    s.run('exit 0');
    expect(s.read('curl')).toContain('skipped two nights in a row');
  });

  it('deploy.sh --apply runs under the same lock, after its host-role check and before any change', () => {
    const deploy = fs.readFileSync(path.join(repo, 'infra/docker/deploy.sh'), 'utf8');
    const role = deploy.indexOf('refuse_inactive_host "$HOST_ROLE" "$HOST_ROLE_RC"');
    const locked = deploy.indexOf('exec python3 "${ROOT_DIR}/infra/ops/deploy_lock.py" --wait "${HAWA_DEPLOY_LOCK_WAIT:-1800}" -- bash "${BASH_SOURCE[0]}" "$@"');
    expect(role).toBeGreaterThan(0);
    expect(locked).toBeGreaterThan(role);
    expect(deploy.indexOf('source "${ROOT_DIR}/infra/ops/release_lib.sh"')).toBeGreaterThan(locked);
    // A deploy that finds the lock held waits for it, then runs holding it.
    const held = spawn('python3', [lock, '--lock', path.join(tmp, 'wait.lock'), '--', '/bin/sleep', '1']);
    const waited = spawnSync('python3', [lock, '--lock', path.join(tmp, 'wait.lock'), '--wait', '20', '--', BASH, '-c', 'echo "held=$HAWA_DEPLOY_LOCK_HELD"'], { encoding: 'utf8' });
    held.kill();
    expect(waited.status).toBe(0);
    expect(waited.stdout).toBe('held=1\n');
  });
});
