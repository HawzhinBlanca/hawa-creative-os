import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The worker steps of infra/docker/deploy.sh (architecture programme 0.1), run in bash with Restate and
 * Docker stubbed. The functions are taken from the script itself, so these tests follow its text.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const deploySh = fs.readFileSync(path.resolve(here, '../../../infra/docker/deploy.sh'), 'utf8');

function fn(name: string): string {
  const start = deploySh.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`deploy.sh has no function ${name}`);
  const end = deploySh.indexOf('\n}\n', start);
  return deploySh.slice(start + 1, end + 3);
}

/** Runs `body` under the script's own shell options, with `bluegreen` answering from `stub`. */
function run(body: string, stub: string) {
  const script = [
    'set -Eeuo pipefail',
    // fd 9 keeps the record even where the script silences a command's output.
    'exec 9>&2',
    // The compose command is recorded, never run.
    'COMPOSE=(record compose); INTERP_FILE=/dev/null; LEGACY_WORKER_CONTAINER=legacy-1',
    'record() { echo "CALL $*" >&9; [[ "${FAIL_RM:-0}" == 1 && " $* " == *" rm "* ]] && return 1; return 0; }',
    'docker() { record docker "$@"; }',
    `bluegreen() { ${stub}; }`,
    fn('stop_worker_slot'), fn('report_drains'), fn('refuse_stuck_legacy'), fn('abandon_idle'),
    body,
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
  return { code: res.status, out: res.stdout, calls: res.stderr.split('\n').filter((l) => l.startsWith('CALL ')) };
}

describe('abandon_idle removes the new colour only when Restate holds nothing at its address', () => {
  it('Restate holds nothing there (a real refusal): the new colour is removed and the deploy stops', () => {
    const r = run('IDLE=blue; LIVE=legacy; abandon_idle "Restate refused."', 'echo registered=; return 0');
    expect(r.code).toBe(1);
    expect(r.calls).toContain('CALL compose --env-file /dev/null rm -sf worker-blue');
    expect(r.out).toMatch(/holds no deployment.*so it was removed/);
  });

  it('Restate holds a deployment there (an accepted registration whose answer was lost, or a partial switch): nothing is removed', () => {
    const r = run('IDLE=blue; LIVE=legacy; abandon_idle "Restate did not complete the switch."', 'printf "registered=dp_blue\\nserves=TaskWorkflow\\n"; return 4');
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => / rm /.test(c))).toEqual([]);
    expect(r.out).toMatch(/was NOT removed.*Both keep running/s);
    expect(r.out).toMatch(/dp_blue/);
  });

  it('Restate cannot be read: nothing is removed', () => {
    const r = run('IDLE=green; LIVE=blue; abandon_idle "x"', 'echo "ERROR: fetch failed" >&2; return 1');
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => / rm /.test(c))).toEqual([]);
  });
});

describe('report_drains and stop_worker_slot', () => {
  it('a container that will not be removed after its deployment was deleted is reported, not fatal under set -e', () => {
    const r = run('FAIL_RM=1 report_drains "deleted=green"; echo AFTER', 'return 0');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/could not be removed/);
    expect(r.out).toMatch(/AFTER/);
  });

  it('a kept deployment is reported with its reason', () => {
    const r = run('report_drains "kept=legacy:Restate still sends TaskService to it"', 'return 0');
    expect(r.out).toMatch(/legacy worker's deployment was kept.*TaskService/);
    expect(r.calls).toEqual([]);
  });
});

describe('refuse_stuck_legacy: the first blue/green deploy waits for paused work on the old single worker', () => {
  it('refuses while paused or backing-off invocations are pinned to it, or their number is unknown', () => {
    for (const stuck of ['2', 'unknown', '']) {
      const r = run(`refuse_stuck_legacy "$(printf 'live=legacy\\nidle=blue\\nlive_stuck=${stuck}')"; echo PASSED`, 'return 0');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Resume or cancel them first/);
    }
  });

  it('goes on when there are none, and never asks once the colours are live', () => {
    expect(run(`refuse_stuck_legacy "$(printf 'live=legacy\\nlive_stuck=0')"; echo PASSED`, 'return 0').out).toMatch(/PASSED/);
    expect(run(`refuse_stuck_legacy "$(printf 'live=blue\\nlive_stuck=')"; echo PASSED`, 'return 0').out).toMatch(/PASSED/);
  });
});
