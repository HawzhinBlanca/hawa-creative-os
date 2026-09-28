import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 4 operations findings 1, 2, 4 and 6 (ADR-129), run in bash with Docker, Compose and Restate
 * stubbed. The functions are taken from infra/docker/deploy.sh itself, as in deploy-sh-worker-steps.
 *
 * 1  A HAWA_TELEGRAM_POLLER switch recreated Core with the new value before the worker colour that
 *    would take over was built, started and registered; a failure in between left nobody polling.
 * 2  register is refused, before anything is sent, for a build that does not host every service
 *    Restate routes to the worker (the hosts come from the new colour's /ready).
 * 4  A HAWA_WORKER_TOKEN change without HAWA_WORKER_TOKEN_PREVIOUS stranded the draining colour.
 * 6  A vector.yaml change never reached the running log shipper.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const deploySh = fs.readFileSync(path.resolve(here, '../../../infra/docker/deploy.sh'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-ops-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fn(name: string): string {
  const start = deploySh.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`deploy.sh has no function ${name}`);
  const end = deploySh.indexOf('\n}\n', start);
  return deploySh.slice(start + 1, end + 3);
}

/** Runs `body` under the script's shell options; `stubs` defines docker and anything else it needs. */
function run(functions: string[], body: string, stubs = '', env: Record<string, string> = {}) {
  const script = [
    'set -Eeuo pipefail',
    'exec 9>&2',
    'CORE_CONTAINER=hawa-production-core-1; INTERP_FILE=/dev/null',
    // The compose command is recorded with the poller value it would interpolate.
    'record() { echo "CALL $* [poller=${HAWA_TELEGRAM_POLLER:-}]" >&9; return 0; }',
    'COMPOSE=(record compose)',
    'docker() { record docker "$@"; }',
    stubs,
    ...functions.map(fn),
    body,
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '', ...env } });
  return { code: res.status, out: res.stdout, calls: res.stderr.split('\n').filter((l) => l.startsWith('CALL ')), err: res.stderr };
}

const line = (needle: string) => {
  const i = deploySh.indexOf(needle);
  if (i < 0) throw new Error(`deploy.sh does not contain ${needle}`);
  return deploySh.slice(0, i).split('\n').length;
};

describe('finding 1: Core keeps its poller until the new worker colour is registered', () => {
  it('telegram_poller_of reads the value as Core and the worker do', () => {
    const r = run(['telegram_poller_of'], 'for v in worker " Worker " "" core other; do telegram_poller_of "$v"; done');
    expect(r.out.trim().split('\n')).toEqual(['worker', 'worker', 'core', 'core', 'core']);
  });

  it('running_core_poller reads the running Core container, and says nothing when there is none', () => {
    const inspect = (envLines: string) => `docker() { [[ "$1" == inspect ]] && { printf '${envLines}'; return 0; }; return 1; }`;
    expect(run(['telegram_poller_of', 'running_core_poller'], 'running_core_poller', inspect('PATH=/bin\\nHAWA_TELEGRAM_POLLER=worker\\n')).out.trim()).toBe('worker');
    expect(run(['telegram_poller_of', 'running_core_poller'], 'running_core_poller', inspect('PATH=/bin\\n')).out.trim()).toBe('core');
    expect(run(['telegram_poller_of', 'running_core_poller'], 'echo "[$(running_core_poller)]"', 'docker() { return 1; }').out.trim()).toBe('[]');
  });

  it('core_poller_hold keeps the running value, and core when no Core runs', () => {
    const cases: Array<[string, string, string]> = [['worker', 'core', 'core'], ['core', 'worker', 'worker'], ['worker', '', 'core'], ['worker', 'worker', 'worker'], ['core', '', 'core']];
    for (const [wanted, running, hold] of cases) {
      expect(run(['core_poller_hold'], `core_poller_hold ${wanted} "${running}"`).out.trim(), `${wanted}/${running}`).toBe(hold);
    }
  });

  it('release_core_poller recreates Core with the wanted value only when it was held', () => {
    const moved = run(['poller_owner_text', 'release_core_poller'], 'CORE_POLLER_HOLD=core; CORE_POLLER_WANTED=worker; release_core_poller; echo "hold=$CORE_POLLER_HOLD"');
    expect(moved.code).toBe(0);
    expect(moved.calls).toEqual(['CALL compose --env-file /dev/null up -d --no-deps --no-build core [poller=worker]']);
    expect(moved.out).toMatch(/hold=worker/);
    expect(moved.out).toMatch(/the live worker colour polls Telegram/);
    const same = run(['poller_owner_text', 'release_core_poller'], 'CORE_POLLER_HOLD=core; CORE_POLLER_WANTED=core; release_core_poller');
    expect(same.calls).toEqual([]);
  });

  it('a deploy that stops after Core was recreated says which process polls, instead of implying nothing changed', () => {
    const held = run(['poller_owner_text', 'report_poller_on_exit'], 'CORE_RECREATED=1; CORE_POLLER_HOLD=core; CORE_POLLER_WANTED=worker; trap report_poller_on_exit EXIT; exit 1');
    expect(held.code).toBe(1);
    expect(held.out).toMatch(/Core was recreated by this deploy with HAWA_TELEGRAM_POLLER=core, not worker/);
    expect(held.out).toMatch(/Core polls Telegram/);
    const early = run(['poller_owner_text', 'report_poller_on_exit'], 'CORE_RECREATED=0; CORE_POLLER_HOLD=core; CORE_POLLER_WANTED=worker; trap report_poller_on_exit EXIT; exit 1');
    expect(early.out).toBe('');
    const fine = run(['poller_owner_text', 'report_poller_on_exit'], 'CORE_RECREATED=1; CORE_POLLER_HOLD=worker; CORE_POLLER_WANTED=worker; trap report_poller_on_exit EXIT; exit 0');
    expect(fine.out).toBe('');
  });

  it('in the script, the step-7 up -d holds the poller, the worker image is built before it, and the release follows register', () => {
    const up = line('HAWA_TELEGRAM_POLLER="$CORE_POLLER_HOLD" "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n');
    expect(line('BUILD_SERVICES+=("worker-${PLAN_IDLE}")')).toBeLessThan(up);
    expect(line('trap report_poller_on_exit EXIT')).toBeLessThan(up);
    expect(line('REGISTERED="$(bluegreen register')).toBeLessThan(line('\nrelease_core_poller\n'));
    expect(line('\nrelease_core_poller\n')).toBeLessThan(line('# 8. Verify health truthfully'));
  });
});

describe('finding 2: register gets the new colour\'s own service list', () => {
  it('idle_hosts reads the services the new colour\'s /ready lists, and "unknown" when it cannot', () => {
    const listed = run(['idle_hosts'], 'idle_hosts blue', 'docker() { echo "$*" >&9; echo "TaskWorkflow,TaskService,ChatInbox"; }');
    expect(listed.out.trim()).toBe('TaskWorkflow,TaskService,ChatInbox');
    expect(listed.err).toMatch(/exec hawa-production-worker-blue-1 node -e .*\/ready/);
    expect(run(['idle_hosts'], 'idle_hosts green', 'docker() { return 1; }').out.trim()).toBe('unknown');
    expect(run(['idle_hosts'], 'idle_hosts green', 'docker() { echo "Task Workflow;rm"; }').out.trim()).toBe('unknown');
  });

  it('the register call passes them', () => {
    expect(deploySh).toMatch(/bluegreen register "\$IDLE" --hosts "\$\(idle_hosts "\$IDLE"\)"/);
  });
});

describe('finding 4: a worker token change needs HAWA_WORKER_TOKEN_PREVIOUS', () => {
  const OLD = ['old', 'worker', 'credential', 'fixture'].join('_');
  const NEW = ['new', 'worker', 'credential', 'fixture'].join('_');
  function check(file: Record<string, string>, running: Record<string, string | null>) {
    const envFile = path.join(tmp, `env-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(envFile, Object.entries(file).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const ps = Object.keys(running).map((n) => `hawa-production-${n}-1`).concat('hawa-production-postgres-1').join('\\n');
    const inspect = Object.entries(running).map(([n, token]) => `hawa-production-${n}-1) printf 'PATH=/bin\\n${token === null ? '' : `HAWA_WORKER_TOKEN=${token}\\n`}' ;;`).join('\n');
    const stubs = `docker() { case "$1" in ps) printf '${ps}\\n' ;; inspect) case "\${@: -1}" in\n${inspect}\n*) return 1 ;; esac ;; *) return 1 ;; esac; }`;
    return run(['container_env', 'env_file_value', 'check_worker_token_rotation'], `ENV_FILE='${envFile}'; check_worker_token_rotation; echo PASSED`, stubs);
  }

  it('the naive rotation (new token, nothing else) is refused before anything changes, and no value is printed', () => {
    const r = check({ HAWA_WORKER_TOKEN: NEW }, { core: OLD, 'worker-blue': OLD });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HAWA_WORKER_TOKEN_PREVIOUS/);
    expect(r.out).toMatch(/core, worker-blue/);
    expect(r.out + r.err).not.toContain(OLD);
    expect(r.out + r.err).not.toContain(NEW);
  });

  it('the first rotation deploy (new token, old one as previous) goes on', () => {
    const r = check({ HAWA_WORKER_TOKEN: NEW, HAWA_WORKER_TOKEN_PREVIOUS: OLD }, { core: OLD, 'worker-blue': OLD });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PASSED/);
    expect(r.out).not.toMatch(/remove it/);
  });

  it('removing the previous token while a colour still runs with it is refused', () => {
    const r = check({ HAWA_WORKER_TOKEN: NEW }, { core: NEW, 'worker-blue': NEW, 'worker-green': OLD });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/worker-green/);
  });

  it('once no worker runs with the previous token, the deploy goes on and says it can be removed', () => {
    const r = check({ HAWA_WORKER_TOKEN: NEW, HAWA_WORKER_TOKEN_PREVIOUS: OLD }, { core: NEW, 'worker-green': NEW });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no running worker uses HAWA_WORKER_TOKEN_PREVIOUS.*remove it/);
  });

  it('a previous token equal to the current one is refused; a worker without any token is ignored', () => {
    expect(check({ HAWA_WORKER_TOKEN: NEW, HAWA_WORKER_TOKEN_PREVIOUS: NEW }, { core: NEW }).code).toBe(1);
    expect(check({ HAWA_WORKER_TOKEN: NEW }, { core: NEW, worker: null }).code).toBe(0);
  });

  it('runs after the previous drains are finished and before the backup', () => {
    const at = line('\ncheck_worker_token_rotation\n');
    expect(at).toBeGreaterThan(line('finish_previous_drains "$PLAN_IDLE"'));
    expect(at).toBeLessThan(line('# 5. Backup before anything changes'));
  });
});

describe('finding 6: a changed vector.yaml reaches the running log shipper', () => {
  const compose = (seen: string, afterRestart: string, runOk = true) =>
    `SEEN='${seen}'; fake() { echo "CALL $*" >&9; case " $* " in *" exec "*) echo "$SEEN  /etc/vector/vector.yaml" ;; *" restart "*) SEEN='${afterRestart}' ;; *" run "*) ${runOk ? 'return 0' : 'return 1'} ;; esac; }; COMPOSE=(fake)`;

  it('nothing is restarted when vector already runs the deployed file', () => {
    const r = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=aaa; apply_vector_config', compose('aaa', 'aaa'));
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => / restart /.test(c))).toEqual([]);
  });

  it('a changed file restarts vector, which must then see it', () => {
    const r = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=bbb; apply_vector_config', compose('aaa', 'bbb'));
    expect(r.code).toBe(0);
    expect(r.calls).toContain('CALL --env-file /dev/null restart vector');
    expect(r.out).toMatch(/vector restarted onto the new vector.yaml/);
    const stuck = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=bbb; apply_vector_config', compose('aaa', 'aaa'));
    expect(stuck.code).toBe(1);
    expect(stuck.out).toMatch(/does not see the deployed vector.yaml/);
  });

  it('an invalid file stops the deploy before anything is started with it', () => {
    const bad = run(['validate_vector_config'], 'validate_vector_config; echo AFTER', compose('', '', false));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/vector validate/);
    expect(bad.out).not.toMatch(/AFTER/);
    const ok = run(['validate_vector_config'], 'validate_vector_config; echo AFTER', compose('', '', true));
    expect(ok.calls[0]).toBe('CALL --env-file /dev/null run --rm --no-deps -T vector validate --no-environment /etc/vector/vector.yaml');
    expect(ok.out).toMatch(/AFTER/);
  });

  it('the file is validated before step 7 starts anything and applied after it', () => {
    const up = line('HAWA_TELEGRAM_POLLER="$CORE_POLLER_HOLD" "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n');
    expect(line('\nvalidate_vector_config\n')).toBeLessThan(up);
    expect(line('\napply_vector_config\n')).toBeGreaterThan(up);
  });
});
