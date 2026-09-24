import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The control flow of infra/backup/restate-nightly.sh (architecture programme 2.6, ADR-034,
 * PHASE2_DESIGN.md section 2.6), run as it is, with the system bash (3.2 on macOS, what the launch
 * agent runs), and with `docker` and `curl` stubbed on PATH. The stub `docker` plays the Restate
 * container (running, health, registration, running invocations), the helper container that tars the
 * volume, and Core's API reached through `docker exec <core> node` (the Telegram kill switch). The
 * stub `curl` is the operator's Telegram alert. Nothing here reaches Docker, Core or Telegram.
 *
 * Every case ends with the kill switch released (unless the office had thrown it) and Restate running.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const script = path.join(repo, 'infra/backup/restate-nightly.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

// The stub Docker. State lives in files under $STUB_STATE; every call is appended to $STUB_STATE/calls.
const DOCKER_STUB = String.raw`#!/bin/bash
S="$STUB_STATE"
echo "docker $*" >> "$S/calls"
get() { cat "$S/$1" 2>/dev/null; }
put() { printf '%s' "$2" > "$S/$1"; }
# The first line of a sequence file, dropped unless it is the last one.
next() { local f="$S/$1" first; first="$(head -1 "$f")"; if [[ "$(wc -l < "$f" | tr -d ' ')" -gt 1 ]]; then tail -n +2 "$f" > "$f.n" && mv "$f.n" "$f"; fi; echo "$first"; }
come_up() {
  put running true; put started_at "started-$RANDOM"
  case "$(get start_mode)" in
    never_healthy) put health unhealthy ;;
    unregistered) put health healthy; put registered 0 ;;
    *) put health healthy; put registered 1 ;;
  esac
}
case "$1" in
  inspect)
    fmt="$3"
    case "$fmt" in
      *Health*) if [[ "$(get running)" == true ]]; then get health; echo; else echo exited; fi ;;
      *State.Running*) get running; echo ;;
      *StartedAt*) get started_at; echo ;;
      *Mounts*) echo stub_restate_data ;;
      *Config.Image*) echo stub/restate:1 ;;
      *) echo "unknown inspect $fmt" >&2; exit 1 ;;
    esac ;;
  stop)
    case "$(get stop_mode)" in
      fail) echo "Error response from daemon: cannot stop container" >&2; exit 1 ;;
      ignored) echo "\${@: -1}"; exit 0 ;;
    esac
    put running false; echo "\${@: -1}" ;;
  start|restart)
    [[ "$(get start_mode)" == fail ]] && { echo "Error response from daemon: cannot start container" >&2; exit 1; }
    come_up; echo "\${@: -1}" ;;
  run)
    args="$*"
    if [[ "$args" == *"--entrypoint du"* ]]; then printf '4096\t/data\n'; exit 0; fi
    if [[ "$args" == *"--entrypoint tar"* ]]; then
      echo started > "$S/tar-started"
      case "$(get tar_mode)" in
        slow) sleep 30 ;;
        fail) echo "tar: /data: Cannot open: Permission denied" >&2; exit 2 ;;
        restarted) come_up ;;
      esac
      exec tar -cf - -C "$STUB_VOLUME" .
    fi
    echo "unexpected docker run $args" >&2; exit 1 ;;
  exec)
    shift
    while [[ "$1" == -* ]]; do if [[ "$1" == -e ]]; then shift; fi; shift; done
    shift # the container
    if [[ "$1" == curl ]]; then
      url="\${@: -1}"
      [[ "$(get running)" == true ]] || { echo "Error response from daemon: container is not running" >&2; exit 1; }
      case "$url" in
        */query) echo "{\"rows\":[{\"n\":$(next running_seq)}]}" ;;
        */services/*) [[ "$(get registered)" == 1 ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }; echo '{"name":"TaskWorkflow"}' ;;
        *) echo "unexpected admin call $url" >&2; exit 22 ;;
      esac
    elif [[ "$1" == node ]]; then
      method="$4"; route="$5"; body="\${6:-}"
      [[ "$(get core_mode)" == down ]] && { echo "0 fetch failed"; exit 0; }
      case "$method $route" in
        "GET /v1/ingress/status")
          if [[ "$(get thrown)" == 1 ]]; then echo '200 {"status":"active","channels":{"telegram":false,"waha":true}}'
          else echo '200 {"status":"active","channels":{"telegram":true,"waha":true}}'; fi ;;
        "POST /v1/ingress/channels/telegram/toggle")
          echo "toggle $body" >> "$S/toggles"
          if [[ "$body" == *'"enabled":false'* ]]; then put thrown 1; echo '200 {"channel":"telegram","enabled":false,"killSwitchActive":true}'
          else
            f="$(get release_failures)"
            if [[ "\${f:-0}" -gt 0 ]]; then put release_failures "$((f - 1))"; echo "503 {\"title\":\"Kill switch not saved\"}"
            else put thrown 0; echo '200 {"channel":"telegram","enabled":true,"killSwitchActive":false}'; fi
          fi ;;
        *) echo "404 {}" ;;
      esac
    else
      echo "unexpected docker exec $*" >&2; exit 1
    fi ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
`.replace(/\\\$\{/g, '${');

// The operator's Telegram alert: recorded, never sent.
const CURL_STUB = `#!/bin/bash
echo "curl $*" >> "$STUB_STATE/alerts"
`;

interface Knobs {
  thrown?: boolean;
  runningSeq?: string[];
  stopMode?: 'ok' | 'fail' | 'ignored';
  startMode?: 'ok' | 'never_healthy' | 'unregistered' | 'fail';
  tarMode?: 'ok' | 'fail' | 'slow' | 'restarted';
  coreMode?: 'ok' | 'down';
  releaseFailures?: number;
  restateRunning?: boolean;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(knobs: Knobs = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-restate-nightly-'));
  dirs.push(t);
  const d = {
    t,
    bin: path.join(t, 'bin'),
    state: path.join(t, 'stub'),
    volume: path.join(t, 'volume'),
    home: path.join(t, 'home'),
    snapshots: path.join(t, 'snapshots'),
    archive: path.join(t, 'archive'),
    keyfile: path.join(t, 'passphrase'),
    notifyEnv: path.join(t, 'env.production'),
    backupState: path.join(t, 'home', '.hawa', 'restate-backup.state'),
  };
  for (const p of [d.bin, d.state, d.volume, d.home, d.snapshots, d.archive]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(d.bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(d.bin, 'curl'), CURL_STUB, { mode: 0o755 });
  // What the stub Restate "holds": a node directory, as the real volume does (/restate-data/<node>/…).
  fs.mkdirSync(path.join(d.volume, 'hawa-restate-prod-1', 'log-store'), { recursive: true });
  fs.writeFileSync(path.join(d.volume, 'hawa-restate-prod-1', 'log-store', '000001.sst'), 'rocksdb bytes '.repeat(200));
  fs.writeFileSync(d.keyfile, ['stub', 'passphrase', String(Date.now())].join('-'), { mode: 0o600 });
  // A fixture bot token built from parts, so no literal credential sits in the repository.
  fs.writeFileSync(d.notifyEnv, `TELEGRAM_BOT_TOKEN=${['700', 'stub'].join(':')}\nTELEGRAM_ALLOWED_USERS=9000001\n`);
  const put = (name: string, value: string) => fs.writeFileSync(path.join(d.state, name), value);
  put('running', knobs.restateRunning === false ? 'false' : 'true');
  put('health', knobs.restateRunning === false ? 'exited' : 'healthy');
  put('registered', '1');
  put('started_at', 'started-first');
  put('thrown', knobs.thrown ? '1' : '0');
  put('running_seq', `${(knobs.runningSeq ?? ['0']).join('\n')}\n`);
  put('stop_mode', knobs.stopMode ?? 'ok');
  put('start_mode', knobs.startMode ?? 'ok');
  put('tar_mode', knobs.tarMode ?? 'ok');
  put('core_mode', knobs.coreMode ?? 'ok');
  put('release_failures', String(knobs.releaseFailures ?? 0));
  put('calls', '');
  return d;
}
type Setup = ReturnType<typeof setup>;

function env(d: Setup, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${d.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: d.home,
    STUB_STATE: d.state,
    STUB_VOLUME: d.volume,
    HAWA_BACKUP_SNAPSHOT_DIR: d.snapshots,
    HAWA_BACKUP_ARCHIVE_DEST: d.archive,
    HAWA_BACKUP_ARCHIVE_KEYFILE: d.keyfile,
    HAWA_BACKUP_ARCHIVE_KEEP: '14',
    HAWA_BACKUP_NOTIFY_ENV: d.notifyEnv,
    HAWA_BACKUP_STAMP: '20260925T013000Z',
    HAWA_RESTATE_PROJECT: 'stubproj',
    HAWA_RESTATE_DRAIN_SECONDS: '2',
    HAWA_RESTATE_SETTLE_SECONDS: '0',
    HAWA_RESTATE_HEALTH_SECONDS: '1',
    HAWA_RESTATE_POLL_SECONDS: '0.2',
    HAWA_RESTATE_RELEASE_ATTEMPTS: '3',
    HAWA_RESTATE_RELEASE_WAIT_SECONDS: '0.1',
    ...extra,
  };
}

function run(d: Setup, extra: Record<string, string> = {}) {
  const res = spawnSync(BASH, [script], { cwd: repo, env: env(d, extra), encoding: 'utf8', timeout: 60_000 });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}`, stderr: res.stderr };
}

const read = (d: Setup, name: string) => (fs.existsSync(path.join(d.state, name)) ? fs.readFileSync(path.join(d.state, name), 'utf8') : '');
const calls = (d: Setup) => read(d, 'calls').split('\n').filter(Boolean);
const logLines = (d: Setup) => (fs.existsSync(path.join(d.snapshots, 'backup.log')) ? fs.readFileSync(path.join(d.snapshots, 'backup.log'), 'utf8').trim().split('\n') : []);
const archived = (d: Setup) => fs.readdirSync(d.archive).sort();
const index = (list: string[], re: RegExp) => list.findIndex((c) => re.test(c));

/** The two promises every case must keep. */
function expectServiceRestored(d: Setup, options: { switchLeftThrown?: boolean } = {}) {
  expect(read(d, 'thrown'), 'the Telegram kill switch').toBe(options.switchLeftThrown ? '1' : '0');
  expect(read(d, 'running'), 'Restate running').toBe('true');
}

describe('restate-nightly.sh: the normal night', () => {
  it('throws the switch, waits for the drain, stops Restate, archives the volume encrypted, starts it, waits for its workers, releases the switch', () => {
    const d = setup({ runningSeq: ['2', '1', '0'] });
    const r = run(d);
    expect(r.code, r.out).toBe(0);
    expectServiceRestored(d);

    const c = calls(d);
    // (The JS passed to `node -e` has newlines, so the route and body end a line of their own.)
    const thrownAt = index(c, / POST \/v1\/ingress\/channels\/telegram\/toggle \{"enabled":false\}$/);
    const drainedAt = c.map((x, i) => (/\/query$/.test(x) ? i : -1)).filter((i) => i >= 0);
    const stopAt = index(c, /^docker stop -t \d+ stubproj-restate-1$/);
    const tarAt = index(c, /--entrypoint tar/);
    const startAt = index(c, /^docker start stubproj-restate-1$/);
    const registeredAt = startAt + index(c.slice(startAt), /\/services\/TaskWorkflow$/);
    const releasedAt = index(c, /toggle \{"enabled":true\}/);
    expect(thrownAt).toBeGreaterThanOrEqual(0);
    expect(drainedAt.length).toBe(3); // 2, 1, then 0 running invocations
    expect(drainedAt[0]).toBeGreaterThan(thrownAt);
    expect(stopAt).toBeGreaterThan(drainedAt[2]);
    expect(tarAt).toBeGreaterThan(stopAt);
    expect(startAt).toBeGreaterThan(tarAt);
    // Healthy and serving the worker's services before intake is switched back on.
    expect(registeredAt).toBeGreaterThan(startAt);
    expect(releasedAt).toBeGreaterThan(registeredAt);
    // The helper container reads the volume read-only, never pulls, and has no network.
    expect(c[tarAt]).toMatch(/--pull never --network none -v stub_restate_data:\/data:ro/);

    // The archive: encrypted with the nightly's cipher, checksummed, and it decrypts to the volume.
    expect(archived(d)).toEqual(['restate_20260925T013000Z.tar.enc', 'restate_20260925T013000Z.tar.enc.sha256']);
    const enc = path.join(d.archive, 'restate_20260925T013000Z.tar.enc');
    const sha = spawnSync('shasum', ['-a', '256', enc], { encoding: 'utf8' }).stdout.split(' ')[0];
    expect(fs.readFileSync(`${enc}.sha256`, 'utf8').trim()).toBe(sha);
    const plain = spawnSync('bash', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "${enc}" -pass "file:${d.keyfile}" | tar -tf -`], { encoding: 'utf8' });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(/hawa-restate-prod-1\/log-store\/000001\.sst/);

    // The nightly log: duration, drain, downtime and the volume's size.
    const ok = logLines(d).find((l) => / RESTATE OK 20260925T013000Z /.test(l)) ?? '';
    expect(ok).toMatch(/total_s=\d+ /);
    expect(ok).toMatch(/drain=clean running_left=0 /);
    expect(ok).toMatch(/down_s=\d+ /);
    expect(ok).toMatch(/volume_bytes=4096 /);
    expect(ok).toMatch(/archive_bytes=\d+ /);
    expect(ok).toMatch(/kill_switch=thrown/);
    // Nothing left behind: no scratch copy, no state file, no alert.
    expect(fs.readdirSync(d.snapshots).filter((n) => n !== 'backup.log')).toEqual([]);
    expect(fs.existsSync(d.backupState)).toBe(false);
    expect(read(d, 'alerts')).toBe('');
  });

  it('a kill switch the office had already thrown is left thrown, and never toggled', () => {
    const d = setup({ thrown: true });
    const r = run(d);
    expect(r.code, r.out).toBe(0);
    expectServiceRestored(d, { switchLeftThrown: true });
    expect(read(d, 'toggles')).toBe('');
    expect(logLines(d).find((l) => / RESTATE OK /.test(l))).toMatch(/kill_switch=found_thrown/);
  });

  it('keeps the newest HAWA_BACKUP_ARCHIVE_KEEP archives and removes older ones with their checksums', () => {
    const d = setup();
    for (const stamp of ['20260920T013000Z', '20260921T013000Z', '20260922T013000Z']) {
      const f = path.join(d.archive, `restate_${stamp}.tar.enc`);
      fs.writeFileSync(f, 'old');
      fs.writeFileSync(`${f}.sha256`, 'x');
      const t = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T01:30:00Z`);
      fs.utimesSync(f, t, t);
    }
    fs.writeFileSync(path.join(d.archive, 'hawa_20260920T013000Z.dump.enc'), 'a postgres dump, not ours');
    const r = run(d, { HAWA_BACKUP_ARCHIVE_KEEP: '2' });
    expect(r.code, r.out).toBe(0);
    expect(archived(d)).toEqual([
      'hawa_20260920T013000Z.dump.enc',
      'restate_20260922T013000Z.tar.enc', 'restate_20260922T013000Z.tar.enc.sha256',
      'restate_20260925T013000Z.tar.enc', 'restate_20260925T013000Z.tar.enc.sha256',
    ]);
  });
});

describe('restate-nightly.sh: every failure leaves the switch released and Restate running', () => {
  it('Restate does not stop (docker stop fails): no archive, Restate untouched, switch released', () => {
    const d = setup({ stopMode: 'fail' });
    const r = run(d);
    expect(r.code).not.toBe(0);
    expectServiceRestored(d);
    expect(calls(d).some((c) => /--entrypoint tar/.test(c))).toBe(false);
    expect(archived(d)).toEqual([]);
    expect(logLines(d).join('\n')).toMatch(/RESTATE FAIL 20260925T013000Z: .*did not stop/);
    expect(read(d, 'alerts')).toMatch(/Restate backup FAILED/);
  });

  it('Restate does not stop (docker stop answers but the container still runs): no archive of a live volume', () => {
    const d = setup({ stopMode: 'ignored' });
    const r = run(d);
    expect(r.code).not.toBe(0);
    expectServiceRestored(d);
    expect(calls(d).some((c) => /--entrypoint tar/.test(c))).toBe(false);
    expect(archived(d)).toEqual([]);
    expect(logLines(d).join('\n')).toMatch(/still running after docker stop/);
  });

  it('tar fails: Restate is started again, the switch released, no archive and no partial file anywhere', () => {
    const d = setup({ tarMode: 'fail' });
    const r = run(d);
    expect(r.code).not.toBe(0);
    expectServiceRestored(d);
    const c = calls(d);
    expect(index(c, /^docker start stubproj-restate-1$/)).toBeGreaterThan(index(c, /--entrypoint tar/));
    expect(archived(d)).toEqual([]);
    expect(fs.readdirSync(d.snapshots).filter((n) => n !== 'backup.log')).toEqual([]);
    expect(logLines(d).join('\n')).toMatch(/RESTATE FAIL 20260925T013000Z: could not archive the Restate volume/);
  });

  it('Restate is started by someone else while its volume is read (the watchdog): the archive is discarded', () => {
    const d = setup({ tarMode: 'restarted' });
    const r = run(d);
    expect(r.code).not.toBe(0);
    expectServiceRestored(d);
    expect(archived(d)).toEqual([]);
    expect(logLines(d).join('\n')).toMatch(/started while its volume was being archived/);
  });

  for (const mode of ['never_healthy', 'unregistered', 'fail'] as const) {
    it(`Restate does not come back (${mode}): says so loudly, alerts, exits 3, and still releases the switch`, () => {
      const d = setup({ startMode: mode });
      const r = run(d);
      expect(r.code).toBe(3);
      expect(read(d, 'thrown')).toBe('0');
      expect(r.stderr).toMatch(/RESTATE IS DOWN/);
      expect(logLines(d).join('\n')).toMatch(/RESTATE FAIL 20260925T013000Z: .*Restate did not come back/);
      expect(read(d, 'alerts')).toMatch(/Restate did not come back/);
      // The archive was taken before the start, and is kept: the volume is intact.
      expect(archived(d)).toContain('restate_20260925T013000Z.tar.enc');
      // Kept so the next night (or an operator) knows Restate was stopped by this job.
      expect(fs.readFileSync(d.backupState, 'utf8')).toMatch(/^restate=1$/m);
    });
  }

  it('running invocations never drain: after HAWA_RESTATE_DRAIN_SECONDS it proceeds (logged as a timeout), since a stop is durable', () => {
    const d = setup({ runningSeq: ['2'] });
    const started = Date.now();
    const r = run(d);
    expect(r.code, r.out).toBe(0);
    // The script counts whole seconds (`date +%s`), so a 2 s deadline is between 1 and 2 s of wall time.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expectServiceRestored(d);
    expect(archived(d)).toContain('restate_20260925T013000Z.tar.enc');
    const ok = logLines(d).find((l) => / RESTATE OK /.test(l)) ?? '';
    expect(ok).toMatch(/drain=timeout running_left=2 /);
    expect(ok).toMatch(/drain_s=[2-9]/);
  });

  it('a signal mid-run (SIGTERM while the volume is being archived): stops at once, starts Restate, releases the switch', async () => {
    const d = setup({ tarMode: 'slow' });
    const child = spawn(BASH, [script], { cwd: repo, env: env(d), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(d.state, 'tar-started')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(d.state, 'tar-started'))).toBe(true);
    const signalledAt = Date.now();
    child.kill('SIGTERM');
    const code = await exited;
    // Not after the 30 s the stub tar would take: the script waits interruptibly.
    expect(Date.now() - signalledAt).toBeLessThan(15_000);
    expect(code, out).toBe(143);
    expectServiceRestored(d);
    expect(archived(d)).toEqual([]);
    expect(logLines(d).join('\n')).toMatch(/RESTATE FAIL 20260925T013000Z: stopped by signal TERM/);
    expect(fs.existsSync(d.backupState)).toBe(false);
  }, 30_000);

  it('Core cannot be reached at the start: nothing is stopped or thrown', () => {
    const d = setup({ coreMode: 'down' });
    const r = run(d);
    expect(r.code).not.toBe(0);
    expectServiceRestored(d);
    expect(calls(d).some((c) => /^docker stop/.test(c))).toBe(false);
    expect(read(d, 'toggles')).toBe('');
    expect(logLines(d).join('\n')).toMatch(/Core did not answer/);
  });

  it('Restate is not running at the start: nothing is stopped, started or thrown', () => {
    const d = setup({ restateRunning: false });
    const r = run(d);
    expect(r.code).not.toBe(0);
    expect(calls(d).some((c) => /^docker (stop|start)/.test(c))).toBe(false);
    expect(read(d, 'toggles')).toBe('');
  });

  it('a release Core refuses at first is tried again until it lands', () => {
    const d = setup({ releaseFailures: 2 });
    const r = run(d);
    expect(r.code, r.out).toBe(0);
    expectServiceRestored(d);
    expect(read(d, 'toggles').split('\n').filter((l) => /"enabled":true/.test(l)).length).toBe(3);
  });

  it('a release that never lands: says so loudly, alerts, exits 3, and keeps the state for the next night', () => {
    const d = setup({ releaseFailures: 99 });
    const r = run(d);
    expect(r.code).toBe(3);
    expect(read(d, 'running')).toBe('true');
    expect(read(d, 'thrown')).toBe('1');
    expect(r.stderr).toMatch(/TELEGRAM INTAKE IS STILL SWITCHED OFF/);
    expect(read(d, 'alerts')).toMatch(/still switched off/);
    expect(fs.readFileSync(d.backupState, 'utf8')).toMatch(/^switch=1$/m);
  });

  it('a run killed outright (SIGKILL) is recovered by the next one: its switch released, its Restate started, then tonight\'s backup', () => {
    const d = setup({ thrown: true, restateRunning: false });
    fs.mkdirSync(path.dirname(d.backupState), { recursive: true });
    // A pid that is not running (the previous run is gone).
    const dead = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(d.backupState, `pid=${dead}\nstamp=20260924T013000Z\nswitch=1\nrestate=1\ncontainer=stubproj-restate-1\n`);
    const r = run(d);
    expect(r.code, r.out).toBe(0);
    expectServiceRestored(d);
    expect(logLines(d).join('\n')).toMatch(/RESTATE RECOVER 20260925T013000Z: the run of 20260924T013000Z was cut off/);
    expect(archived(d)).toContain('restate_20260925T013000Z.tar.enc');
    expect(read(d, 'alerts')).toMatch(/cut off/);
  });

  it('refuses an unreadable passphrase file before touching anything', () => {
    const d = setup();
    const r = run(d, { HAWA_BACKUP_ARCHIVE_KEYFILE: path.join(d.t, 'missing') });
    expect(r.code).not.toBe(0);
    expect(calls(d).some((c) => /^docker (stop|start)/.test(c))).toBe(false);
    expect(read(d, 'toggles')).toBe('');
    expect(r.out).toMatch(/refusing to write an unencrypted/);
  });
});
