import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { resolveWorkspaceFile } from './migrate.js';
import { isForwardMigration } from './migration-files.js';

export function discoverMigrations(migrationsDir?: string): string[] {
  const dir = migrationsDir || resolveWorkspaceFile('packages/db/migrations');
  const files = readdirSync(dir)
    .filter(isForwardMigration)
    .sort();

  for (let i = 0; i < files.length; i++) {
    const num = parseInt(files[i].slice(0, 3), 10);
    if (num !== i + 1) {
      throw new Error(`Migration sequence gap or mismatch at ${files[i]}: expected ${(i + 1).toString().padStart(3, '0')}`);
    }
  }
  return files;
}

/**
 * `through` stops after that migration number: only the pre-deploy check's replay of a past release
 * (predeploy-dump-check.ts --through) uses it; a deploy always applies every migration.
 */
export async function upgradeCanvaSchema(connectionString: string, options: { through?: number } = {}): Promise<{ applied: string[]; verified: string[] }> {
  if (!connectionString) throw new Error('DATABASE_URL is required; no implicit target or successful dry run');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  const result: { applied: string[]; verified: string[] } = { applied: [], verified: [] };
  const upgrades = discoverMigrations().filter((name) => options.through === undefined || parseInt(name.slice(0, 3), 10) <= options.through!);
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
