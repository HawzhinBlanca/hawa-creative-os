import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { upgradeCanvaSchema } from '../src/upgrade.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && new URL(url).pathname !== '/hawa_repair') throw new Error('Isolated hawa_repair database required');
describe('versioned upgrade configuration', () => {
  it('refuses to report success without a target database', async () => {
    await expect(upgradeCanvaSchema('')).rejects.toThrow('DATABASE_URL is required');
  });
});
describe.skipIf(!url)('real PostgreSQL versioned upgrade', () => {
  it('applies once and concurrent retries verify the same recorded migrations', async () => {
    await upgradeCanvaSchema(url!);
    const results = await Promise.all([upgradeCanvaSchema(url!), upgradeCanvaSchema(url!)]);
    for (const result of results) {
      expect(result.applied).toEqual([]);
      expect(result.verified).toEqual(['001_canva_bindings.sql', '002_canva_binding_isolation.sql', '003_canva_connect.sql', '004_canva_task_scope_lock.sql', '005_canva_runtime_permissions.sql', '006_canva_editable_sources.sql', '007_canva_design_plans.sql', '008_canva_roundtrip_checks.sql', '009_correct_kaae_identity.sql']);
    }
  });
  it('rejects a changed applied checksum and leaves the receipt intact', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const name = '002_canva_binding_isolation.sql';
    const original = (await client.query('SELECT sha256 FROM hawa.schema_upgrades WHERE name = $1', [name])).rows[0].sha256;
    try {
      await client.query('UPDATE hawa.schema_upgrades SET sha256 = $1 WHERE name = $2', ['test-corruption', name]);
      await expect(upgradeCanvaSchema(url!)).rejects.toThrow('checksum mismatch');
      expect((await client.query('SELECT sha256 FROM hawa.schema_upgrades WHERE name = $1', [name])).rows[0].sha256).toBe('test-corruption');
    } finally {
      await client.query('UPDATE hawa.schema_upgrades SET sha256 = $1 WHERE name = $2', [original, name]);
      await client.end();
    }
  });
});
