import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Step 8 of infra/docker/deploy.sh: Core's health after the switch, run in bash with curl answering a
 * sequence of health documents and sleep stubbed. The function is taken from the script itself.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const deploySh = fs.readFileSync(path.resolve(here, '../../../infra/docker/deploy.sh'), 'utf8');

function fn(name: string): string {
  const start = deploySh.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`deploy.sh has no function ${name}`);
  const end = deploySh.indexOf('\n}\n', start);
  return deploySh.slice(start + 1, end + 3);
}

const healthy = { postgres: 'connected', restate: 'connected', telegramApi: 'connected', canva: 'connected', modelProvider: 'connected' };
const doc = (deps: Record<string, string>) => JSON.stringify({ status: 'ok', dependencies: { ...healthy, ...deps } });

/** Runs verify_core_health with curl answering `answers` in turn (the last one repeats). */
function run(answers: string[], attempts = 3) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'deploy-health-'));
  answers.forEach((a, i) => fs.writeFileSync(path.join(dir, `a${i}`), a));
  const script = [
    'set -Eeuo pipefail',
    `ANSWERS=${JSON.stringify(dir)}; N=${answers.length}; echo 0 > "$ANSWERS/n"`,
    'curl() { local n; n=$(cat "$ANSWERS/n"); echo $((n+1)) > "$ANSWERS/n"; (( n >= N )) && n=$((N-1)); cat "$ANSWERS/a$n"; }',
    'sleep() { echo "SLEEP $1" >&2; }',
    `HAWA_HEALTH_ATTEMPTS=${attempts}`,
    fn('verify_core_health'),
    'verify_core_health',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
  const asked = Number(fs.readFileSync(path.join(dir, 'n'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: res.status, out: res.stdout, asked };
}

describe('deploy.sh step 8: Core health after the switch', () => {
  it('passes at once when every dependency is healthy', () => {
    const r = run([doc({})]);
    expect(r.code).toBe(0);
    expect(r.asked).toBe(1);
    expect(r.out).not.toMatch(/WARNING|ERROR/);
  });

  it('asks again when Telegram is briefly unreachable, and passes once it answers', () => {
    const r = run([doc({ telegramApi: 'unreachable' }), doc({})]);
    expect(r.code).toBe(0);
    expect(r.asked).toBe(2);
    expect(r.out).toMatch(/attempt 1 of 3/);
    expect(r.out).not.toMatch(/WARNING|ERROR/);
  });

  it('ends with a warning, not a failure, when only internet services stay unreachable', () => {
    const r = run([doc({ telegramApi: 'unreachable', canva: 'unreachable' })]);
    expect(r.code).toBe(0);
    expect(r.asked).toBe(3);
    expect(r.out).toMatch(/WARNING: only internet services are unreachable/);
  });

  it('fails when a credential is refused, even for an internet service', () => {
    const r = run([doc({ telegramApi: 'unauthorized' })]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR: unhealthy dependencies/);
  });

  it('fails when Postgres stays disconnected, even if the internet is out too', () => {
    const r = run([doc({ postgres: 'disconnected', telegramApi: 'unreachable' })]);
    expect(r.code).toBe(1);
    expect(r.asked).toBe(3);
    expect(r.out).toMatch(/ERROR: unhealthy dependencies/);
  });

  it('passes when an internal dependency recovers on a later attempt', () => {
    const r = run([doc({ restate: 'disconnected' }), doc({})]);
    expect(r.code).toBe(0);
    expect(r.asked).toBe(2);
  });

  it('fails when Core never answers', () => {
    const script = ['set -Eeuo pipefail', 'curl() { return 7; }', 'sleep() { :; }', fn('verify_core_health'), 'verify_core_health'].join('\n');
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/core health did not answer within 60 s/);
  });
});

/**
 * Hunt 3: step 5 waited for Postgres with `until docker exec … pg_isready; do sleep 1; done`. A Postgres
 * that never came back (a crash loop, a full Docker disk) hung the deploy forever while it held the deploy
 * lock, so the nightly canary skipped night after night and the next deploy waited out its 30 minutes.
 */
describe('deploy.sh step 5: waiting for Postgres is bounded', () => {
  function wait(readyAfter: number | null, seconds = 5) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'deploy-pg-wait-'));
    const script = [
      'set -Eeuo pipefail',
      `N=${JSON.stringify(path.join(dir, 'n'))}; echo 0 > "$N"`,
      `docker() { local n; n=$(cat "$N"); echo $((n+1)) > "$N"; ${readyAfter === null ? 'return 1' : `(( n >= ${readyAfter} ))`}; }`,
      'sleep() { :; }',
      `HAWA_POSTGRES_READY_SECONDS=${seconds}`,
      fn('wait_for_postgres'),
      'wait_for_postgres; echo "after"',
    ].join('\n');
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '' }, timeout: 10_000 });
    const asked = Number(fs.readFileSync(path.join(dir, 'n'), 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: res.stdout, asked, timedOut: res.error !== undefined };
  }

  it('goes on once pg_isready answers', () => {
    const r = wait(2);
    expect(r.code).toBe(0);
    expect(r.out).toContain('after');
    expect(r.asked).toBe(3);
  });

  it('stops the deploy with a reason once the wait is over, instead of hanging under the deploy lock', () => {
    const r = wait(null, 5);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('after');
    expect(r.out).toMatch(/ERROR: Postgres did not answer pg_isready within 5 s; nothing was changed/);
    expect(r.asked).toBe(5);
  });

  it('the backup step uses it', () => {
    expect(deploySh).not.toMatch(/until docker exec hawa-production-postgres-1 pg_isready/);
    expect(deploySh).toMatch(/up -d --no-recreate postgres\nwait_for_postgres \|\| exit 1\n/);
  });
});
