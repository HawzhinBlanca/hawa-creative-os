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
    // CANDIDATE_RUNTIME: the checked copy the one-off vector check binds its file from (ADR-158, addendum 3).
    'CORE_CONTAINER=hawa-production-core-1; INTERP_FILE=/dev/null; ROOT_DIR=/srv/hawa-release; CANDIDATE_RUNTIME=/srv/hawa-runtime.candidate',
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

// Finding 1 (ADR-129) held Core's poller value until the new worker colour was registered. Stage 2
// of ADR-135 removed Core's poller, and with it the hold, the release and the exit note: only the
// worker polls, and step 7 starts everything with HAWA_TELEGRAM_POLLER=worker.
describe('finding 1 after ADR-135 stage 2: nothing is held for Core, which does not poll', () => {
  it('telegram_poller_of reads the value as the worker does', () => {
    const r = run(['telegram_poller_of'], 'for v in worker " Worker " "" core other; do telegram_poller_of "$v"; done');
    expect(r.out.trim().split('\n')).toEqual(['worker', 'worker', 'core', 'core', 'core']);
  });

  it('the hold, release and exit note of Core\'s poller are gone, and step 7 starts with worker', () => {
    for (const gone of ['running_core_poller() {', 'core_poller_hold() {', 'release_core_poller() {', 'report_poller_on_exit() {', 'CORE_POLLER_HOLD', 'IDLE_KEPT']) {
      expect(deploySh, gone).not.toContain(gone);
    }
    const up = line('HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n');
    expect(line('BUILD_SERVICES+=("worker-${PLAN_IDLE}")')).toBeLessThan(up);
    expect(line('REGISTERED="$(bluegreen register')).toBeGreaterThan(up);
  });
});

// ADR-135: only the worker polls. Core no longer polls whatever the value, so a deploy with any other
// value would leave nobody reading client messages, and a rollback to Core's poller would start
// requests on the old path. It is refused before anything changes, in pre-flight too.
describe('ADR-135: the Telegram poller is the worker', () => {
  it('refuse_retired_poller passes worker only, and says nothing was changed', () => {
    for (const value of ['worker', ' Worker ']) {
      const ok = run(['telegram_poller_of', 'refuse_retired_poller'], `refuse_retired_poller "${value}"; echo passed`);
      expect(ok.code, value).toBe(0);
      expect(ok.out).toMatch(/passed/);
    }
    for (const value of ['core', '', 'other']) {
      const refused = run(['telegram_poller_of', 'refuse_retired_poller'], `refuse_retired_poller "${value}"; echo passed`);
      expect(refused.code, value).toBe(1);
      expect(refused.out).not.toMatch(/passed/);
      expect(refused.out).toMatch(/Core no longer polls Telegram \(ADR-135\).*Nothing was changed/);
      expect(refused.calls).toEqual([]);
    }
  });

  it('in the script, the refusal comes before the pre-flight exit, the backup and step 7, and the default is worker', () => {
    const refusal = line('refuse_retired_poller "$(compose_value HAWA_TELEGRAM_POLLER worker)"');
    expect(refusal).toBeLessThan(line('if [[ $APPLY == 0 ]]; then'));
    expect(refusal).toBeLessThan(line('# 5. Backup before anything changes'));
    expect(refusal).toBeLessThan(line('HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n'));
    expect(deploySh).not.toMatch(/compose_value HAWA_TELEGRAM_POLLER core/);
    const compose = fs.readFileSync(path.resolve(here, '../../../infra/docker/docker-compose.prod.yml'), 'utf8');
    expect(compose.match(/HAWA_TELEGRAM_POLLER: \$\{HAWA_TELEGRAM_POLLER:-worker\}/g)).toHaveLength(2);
    expect(compose).not.toMatch(/HAWA_TELEGRAM_POLLER:-core/);
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

  // Phase 4 review of 72cb6fae: the --hosts refusal came in 7b, after step 7 had already replaced Core
  // and the Desk with the refused checkout's build. The idle image is built before step 7, so its own
  // service list is checked there, while everything still runs the previous build.
  it('image_hosts reads the list from the built image itself, with no network, and "unknown" when it cannot', () => {
    const stubs = (answer: string) => `compose_image_ref() { echo "hawa-worker:1"; }\ndocker() { echo "$*" >&9; ${answer}; }`;
    const listed = run(['image_hosts'], 'image_hosts worker-green', stubs('echo "TaskWorkflow,TaskService,ChatInbox"'));
    expect(listed.out.trim()).toBe('TaskWorkflow,TaskService,ChatInbox');
    expect(listed.err).toMatch(/^run --rm --pull never --network none --entrypoint node hawa-worker:1 -e .*services\.js/m);
    expect(run(['image_hosts'], 'image_hosts worker-green', stubs('return 1')).out.trim()).toBe('unknown');
    expect(run(['image_hosts'], 'image_hosts worker-green', stubs('echo ""')).out.trim()).toBe('unknown');
    expect(run(['image_hosts'], 'image_hosts worker-green', 'compose_image_ref() { return 1; }\ndocker() { echo TaskWorkflow; }').out.trim()).toBe('unknown');
  });

  it('refuse_split_worker_build stops the deploy when check-hosts refuses, and goes on when it accepts', () => {
    const stubs = (rc: number) => `image_hosts() { echo "TaskWorkflow,TaskService"; }\nbluegreen() { echo "BG $*" >&9; [[ ${rc} == 0 ]] && echo "hosts=ok" || echo "ERROR: the new build does not host ChatInbox" >&2; return ${rc}; }`;
    const refused = run(['refuse_split_worker_build'], 'refuse_split_worker_build worker-green; echo AFTER', stubs(2));
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/BG check-hosts --hosts TaskWorkflow,TaskService/);
    expect(refused.out).toMatch(/ChatInbox/);
    expect(refused.out).toMatch(/Nothing was started.*previous build/);
    expect(refused.out).not.toMatch(/AFTER/);
    const unreadable = run(['refuse_split_worker_build'], 'refuse_split_worker_build worker-green; echo AFTER', stubs(1));
    expect(unreadable.code).toBe(1);
    const ok = run(['refuse_split_worker_build'], 'refuse_split_worker_build worker-green; echo AFTER', stubs(0));
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/AFTER/);
  });

  it('in the script, the idle build is checked after it is built and verified, and before step 7 replaces Core', () => {
    const at = line('[[ -z "$PLAN_IDLE" ]] || refuse_split_worker_build "worker-${PLAN_IDLE}"\n');
    expect(at).toBeGreaterThan(line('[[ -z "$PLAN_IDLE" ]] || verify_built_image "worker-${PLAN_IDLE}"'));
    expect(at).toBeLessThan(line('HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n'));
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
  const compose = (seen: string, afterRestart: string, runOk = true, afterRecreate = afterRestart) =>
    `SEEN='${seen}'; fake() { echo "CALL $*" >&9; case " $* " in *" exec "*) echo "$SEEN  /etc/vector/vector.yaml" ;; *" restart "*) SEEN='${afterRestart}' ;; *" up "*) SEEN='${afterRecreate}' ;; *" run "*) ${runOk ? 'return 0' : 'return 1'} ;; esac; }; COMPOSE=(fake)`;

  it('nothing is restarted when vector.yaml did not change and vector already sees it', () => {
    const r = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=aaa; VECTOR_CHANGED=0; apply_vector_config', compose('aaa', 'aaa'));
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => / (restart|up) /.test(c))).toEqual([]);
  });

  it('a file changed in place is already seen but not yet read: vector is restarted (addendum 3)', () => {
    const r = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=bbb; VECTOR_CHANGED=1; apply_vector_config', compose('bbb', 'bbb'));
    expect(r.code).toBe(0);
    expect(r.calls).toContain('CALL --env-file /dev/null restart vector');
    expect(r.out).toMatch(/vector restarted onto the deployed vector.yaml/);
  });

  it('a mount pinned to an old file is restarted, then recreated, and the deploy stops if vector still does not see it', () => {
    const r = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=bbb; VECTOR_CHANGED=0; apply_vector_config', compose('aaa', 'aaa', true, 'bbb'));
    expect(r.code).toBe(0);
    expect(r.calls).toContain('CALL --env-file /dev/null restart vector');
    expect(r.calls).toContain('CALL --env-file /dev/null up -d --no-deps --force-recreate vector');
    expect(r.out).toMatch(/vector recreated onto the deployed vector.yaml/);
    const stuck = run(['vector_seen', 'apply_vector_config'], 'VECTOR_WANT=bbb; VECTOR_CHANGED=1; apply_vector_config', compose('aaa', 'aaa'));
    expect(stuck.code).toBe(1);
    expect(stuck.out).toMatch(/ERROR: vector does not see the deployed vector.yaml even after it was recreated/);
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

  it('the one-off check binds the candidate copy, not the live runtime directory', () => {
    const r = run(['validate_vector_config'], 'validate_vector_config', 'fake() { echo "CALL HAWA_RUNTIME_DIR=${HAWA_RUNTIME_DIR:-} $*" >&9; }; COMPOSE=(fake)');
    expect(r.calls[0]).toBe('CALL HAWA_RUNTIME_DIR=/srv/hawa-runtime.candidate --env-file /dev/null run --rm --no-deps -T vector validate --no-environment /etc/vector/vector.yaml');
  });

  it('the file is validated before step 7 starts anything and applied after it', () => {
    const up = line('HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n');
    expect(line('\nvalidate_vector_config\n')).toBeLessThan(up);
    expect(line('\napply_vector_config\n')).toBeGreaterThan(up);
  });
});
