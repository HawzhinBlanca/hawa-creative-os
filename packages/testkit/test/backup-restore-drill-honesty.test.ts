import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/backup/backup_restore_drill.sh, the weekly launch agent (audit 2026-09-30 P2, ADR-158). It
 * restores no backup, yet recorded a "passed" clean-host recovery in hawa.backup_drills with 52
 * tables and 24 policies written into the script, a target time of its own start and an RPO of 0.
 * It now records a static check: drill_type static_schema_parity, restore_performed false, no target
 * or RPO, the counts read from the files, and "failed" when a check fails.
 *
 * docker and pnpm are stubs: the SQL the script sends is captured, and pnpm passes or fails on demand.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-drill-honesty-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(pnpmExit: number) {
  const t = fs.mkdtempSync(path.join(tmp, 'run-'));
  const bin = path.join(t, 'bin');
  fs.mkdirSync(bin);
  const sqlFile = path.join(t, 'sql');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\n[[ "$*" == *psql* ]] && cat >> '${sqlFile}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/bash\nexit ${pnpmExit}\n`, { mode: 0o755 });
  const res = spawnSync(BASH, [path.join(repo, 'infra/backup/backup_restore_drill.sh')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(t, 'home'), HAWA_DRILL_SNAPSHOT_DIR: path.join(t, 'snapshots') },
  });
  return { code: res.status, out: res.stdout + res.stderr, sql: fs.existsSync(sqlFile) ? fs.readFileSync(sqlFile, 'utf8') : '' };
}

const count = (file: string, re: RegExp) => fs.readFileSync(path.join(repo, file), 'utf8').split('\n').filter((l) => re.test(l)).length;

describe('the weekly schema check says what it did', () => {
  it('records a passed static check with counts from the files, no restore, no target time and no RPO', () => {
    const r = run(0);
    expect(r.code, r.out).toBe(0);
    expect(r.sql).toContain("'drill_type', 'static_schema_parity'");
    expect(r.sql).toContain("'restore_performed', false");
    expect(r.sql).toMatch(/'passed'/);
    expect(r.sql).toContain(`'tables_in_schema_file', ${count('db/schema.sql', /^\s*CREATE TABLE/i)}`);
    expect(r.sql).toContain(`'policies_in_rls_file', ${count('db/rls.sql', /^\s*CREATE POLICY/i)}`);
    // No written-in counts, no invented recovery point.
    expect(r.sql).not.toMatch(/tables_verified|policies_verified|clean_host/);
    expect(r.sql).toMatch(/'\d{4}-\d\d-\d\dT[\d:]+Z',\s*NULL,\s*NULL,/);
    expect(r.out).toContain('No backup was restored');
    expect(r.out).not.toMatch(/recovery verified|100% schema parity/i);
  });

  it('records "failed", and never "passed", when a check fails', () => {
    const r = run(1);
    expect(r.code).not.toBe(0);
    expect(r.sql).toMatch(/'failed'/);
    expect(r.sql).not.toMatch(/'passed'/);
    expect(r.sql).toContain("'restore_performed', false");
  });
});
