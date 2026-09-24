import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneStartedAt, newRunId, templateHash, templateSources, withDatabase } from '../src/test-template.js';

const root = resolve(import.meta.dirname, '../../..');

describe('per-file test databases', () => {
  it('refuses to point a per-file database at production or away from the test server', () => {
    const base = ['postgresql://u:p@127.0.0.1:55432', 'hawa_test'].join('/');
    expect(withDatabase(base, 'hawa_t_x_1')).toMatch(/\/hawa_t_x_1$/);
    expect(() => withDatabase(base.replace('55432', '54332'), 'hawa_t_x_1')).toThrow(/production/);
    expect(() => withDatabase(base, 'hawa')).toThrow(/live database/);
    expect(() => withDatabase(base.replace('55432', '5432'), 'hawa_t_x_1')).toThrow(/test server/);
  });

  it('ages clones by the run id in their name and ignores names it did not make', () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0);
    const run = newRunId(now);
    expect(cloneStartedAt(`hawa_t_${run}_4242`)).toBe(Math.floor(now / 1000));
    expect(cloneStartedAt(`hawa_tr_${run}_7`)).toBe(Math.floor(now / 1000));
    expect(cloneStartedAt('hawa_test')).toBeNull();
    expect(cloneStartedAt('hawa_tpl_test_abc')).toBeNull();
    expect(`hawa_tr_${run}_${99999}${999999}`.length).toBeLessThanOrEqual(63);
  });

  it('builds a new template whenever a schema, RLS, seed, fixture or migration file changes', () => {
    const copy = mkdtempSync(join(tmpdir(), 'hawa-tpl-'));
    for (const file of templateSources(root)) {
      mkdirSync(join(copy, file, '..'), { recursive: true });
      cpSync(join(root, file), join(copy, file));
    }
    const before = templateHash(copy);
    expect(templateHash(copy)).toBe(before);
    writeFileSync(join(copy, 'packages/db/migrations/999_new.sql'), 'SELECT 1;');
    const withMigration = templateHash(copy);
    expect(withMigration).not.toBe(before);
    writeFileSync(join(copy, 'db/rls.sql'), '-- changed');
    expect(templateHash(copy)).not.toBe(withMigration);
  });
});
