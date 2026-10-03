import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverMigrations } from '../../db/src/upgrade.js';

/**
 * The release manifest's migration target is the migration the upgrader applies last. Deploy 1e6881ac
 * (2026-10-03) applied 089_customer_acceptance_downloads.sql, but the manifest scripts filtered out any
 * name containing "_down" ("_downloads"), so the manifest declared 088 and the receipt check refused
 * to admit the deployment. The scripts and the upgrader must agree on which files are migrations.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptFilter = (file: string) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return /filter\(\(f\) => f\.endsWith\('\.sql'\) && !f\.endsWith\('_down\.sql'\)\)/.test(source);
};

describe('the release manifest names the migration the upgrader applies last', () => {
  it('both manifest scripts exclude only *_down.sql rollback files, as the upgrader does', () => {
    expect(scriptFilter('scripts/generate_release_manifest.ts')).toBe(true);
    expect(scriptFilter('scripts/verify_release_manifest.ts')).toBe(true);
  });

  it('a migration whose name merely contains "_down" is still a migration', () => {
    const files = discoverMigrations(path.join(root, 'packages/db/migrations'));
    const keep = (f: string) => f.endsWith('.sql') && !f.endsWith('_down.sql');
    const all = fs.readdirSync(path.join(root, 'packages/db/migrations')).filter(keep).sort();
    expect(all.filter((f) => /^\d{3}_/.test(f))).toEqual(files);
    expect(keep('089_customer_acceptance_downloads.sql')).toBe(true);
    expect(keep('001_canva_bindings_down.sql')).toBe(false);
  });
});
