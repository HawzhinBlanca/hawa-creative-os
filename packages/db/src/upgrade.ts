import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { resolveWorkspaceFile } from './migrate.js';

// An explicit ordered list excludes rollback scripts and does not replay schema.sql.
const upgrades = ['001_canva_bindings.sql', '002_canva_binding_isolation.sql', '003_canva_connect.sql', '004_canva_task_scope_lock.sql', '005_canva_runtime_permissions.sql', '006_canva_editable_sources.sql', '007_canva_design_plans.sql', '008_canva_roundtrip_checks.sql', '009_correct_kaae_identity.sql', '010_canva_plan_abandon.sql', '011_desk_sessions.sql', '012_service_identities.sql', '013_design_studio.sql'] as const;

export async function upgradeCanvaSchema(connectionString: string): Promise<{ applied: string[]; verified: string[] }> {
  if (!connectionString) throw new Error('DATABASE_URL is required; no implicit target or successful dry run');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  const result: { applied: string[]; verified: string[] } = { applied: [], verified: [] };
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hawa.versioned_upgrades'))");
    // A populated office schema must exist. This command cannot initialize or erase it.
    await client.query('SELECT 1 FROM hawa.tasks LIMIT 0');
    await client.query(`CREATE TABLE IF NOT EXISTS hawa.schema_upgrades (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of upgrades) {
      const source = readFileSync(resolveWorkspaceFile(`packages/db/migrations/${name}`), 'utf8');
      const sha256 = createHash('sha256').update(source).digest('hex');
      const prior = await client.query('SELECT sha256 FROM hawa.schema_upgrades WHERE name = $1', [name]);
      if (prior.rows.length) {
        if (prior.rows[0].sha256 !== sha256) throw new Error(`Applied migration checksum mismatch: ${name}`);
        result.verified.push(name);
        continue;
      }
      // SQL files are repository-owned and also executable by psql. The runner owns
      // the outer transaction so all upgrades and their receipts commit together.
      const body = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
      await client.query(body);
      await client.query('INSERT INTO hawa.schema_upgrades(name, sha256) VALUES ($1, $2)', [name, sha256]);
      result.applied.push(name);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  upgradeCanvaSchema(process.env.DATABASE_URL || '').then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Schema upgrade failed'); process.exitCode = 1; });
}
