import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The restore-swap block of runbooks/10_backup_restore.md (ADR-129, Phase 4 operations finding 26),
 * checked from its text: infra/backup/drill_restore_swap.sh runs it against the test server with a
 * real dump, which this file cannot. Phase 4 review of 72cb6fae: pg_dump -Fc carries neither the
 * database's grants (GRANT ... ON DATABASE) nor its settings (ALTER DATABASE ... SET, ALTER ROLE ...
 * IN DATABASE ... SET), and the rename leaves them with the old database, so the block copies and
 * compares them before it swaps.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const runbook = fs.readFileSync(path.join(root, 'runbooks/10_backup_restore.md'), 'utf8');
// As the drill extracts it.
const block = (() => {
  const m = /<!-- restore-swap:begin -->\n([\s\S]*?)<!-- restore-swap:end -->/.exec(runbook);
  if (!m) throw new Error('runbooks/10_backup_restore.md has no restore-swap block');
  return m[1].split('\n').map((l) => l.replace(/^ {3}/, '')).filter((l) => !l.startsWith('```')).join('\n');
})();
const at = (needle: string) => {
  const i = block.indexOf(needle);
  if (i < 0) throw new Error(`the block does not contain ${needle}`);
  return i;
};

describe('restore-swap block', () => {
  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n', '-c', block], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('copies the database owner, grants and settings, compares them, and only then renames', () => {
    const rename = at('ALTER DATABASE \\"${DB}\\" RENAME TO');
    expect(at('elif ! copy_props; then')).toBeLessThan(rename);
    expect(at('[[ "$P_DB" != owner=* || "$P_NEW" != "$P_DB" ]]')).toBeLessThan(rename);
    expect(at('elif ! copy_props; then')).toBeGreaterThan(at('if [[ "$HAVE" != "$WANT" ]]; then'));
    expect(block).toMatch(/copy_props\(\) \{ .*-v src="\$DB" -v dst="\$NEW" < infra\/backup\/restore_copy_props\.sql; \}/);
    expect(block).toMatch(/props\(\) \{ .*-v name="\$1" < infra\/backup\/restore_props\.sql; \}/);
  });

  it('the SQL it reads exists and covers grants, database settings and per-database role settings', () => {
    const copy = fs.readFileSync(path.join(root, 'infra/backup/restore_copy_props.sql'), 'utf8');
    const props = fs.readFileSync(path.join(root, 'infra/backup/restore_props.sql'), 'utf8');
    expect(copy).toMatch(/aclexplode\(src\.datacl\)/);
    expect(copy).toMatch(/REVOKE ALL ON DATABASE %I FROM PUBLIC/);
    expect(copy).toMatch(/ALTER DATABASE %I SET %s TO %L/);
    expect(copy).toMatch(/ALTER ROLE %I IN DATABASE %I SET %s TO %L/);
    expect(copy).toMatch(/ALTER DATABASE %I OWNER TO %I/);
    for (const part of ['datdba', 'encoding', 'datcollate', 'acldefault', 'pg_db_role_setting']) expect(props).toContain(part);
    // string_agg(... ORDER BY 1) orders by the constant 1, not the value: the comparison then depends
    // on catalog order (found while drilling this block).
    expect(props).not.toMatch(/ORDER BY 1\)/);
  });

  it('counts a dump without policies, foreign keys or triggers as 0 instead of stopping under set -e', () => {
    const toc = block.slice(at('toc_count() {'), at('WANT='));
    const r = spawnSync('bash', ['-Eeuo', 'pipefail', '-c', `TOC=''\n${toc}\necho "[$(toc_count POLICY)]"`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('[0]');
  });
});
