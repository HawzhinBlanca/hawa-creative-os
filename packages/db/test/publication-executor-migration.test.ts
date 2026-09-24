import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Migration 022: who delivers a publication (architecture programme Phase 2, slice 2.2; ADR-034).
 * Every existing row is Core's; the Delivery workflow's runs are counted, and a run can only report
 * back after it was started.
 */
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

describe.skipIf(!ownerUrl)('migration 022: publications.executor', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  beforeAll(async () => { await owner.connect(); });
  afterAll(async () => { await owner.end(); });

  it('is recorded by the upgrade runner', async () => {
    const r = await owner.query(`SELECT name FROM hawa.schema_upgrades WHERE name = '022_publication_executor.sql'`);
    expect(r.rowCount).toBe(1);
  });

  it("makes every publication Core's, with no workflow run, unless it says otherwise", async () => {
    const cols = await owner.query(`SELECT column_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'hawa' AND table_name = 'publications' AND column_name IN ('executor', 'executor_run', 'executor_finished_run')
      ORDER BY column_name`);
    expect(cols.rows).toEqual([
      { column_name: 'executor', column_default: "'core'::text", is_nullable: 'NO' },
      { column_name: 'executor_finished_run', column_default: '0', is_nullable: 'NO' },
      { column_name: 'executor_run', column_default: '0', is_nullable: 'NO' },
    ]);
  });

  it('accepts only core or restate, and no report of a run that was never started', async () => {
    const defs = await owner.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'hawa.publications'::regclass AND conname IN ('publications_executor_check', 'publications_executor_run_check')
      ORDER BY conname`);
    expect(defs.rows.map((r) => r.conname)).toEqual(['publications_executor_check', 'publications_executor_run_check']);
    // Each CHECK evaluated on candidate values, with the table's own expression.
    const holds = async (executor: string, run: number, finished: number) => {
      const expr = defs.rows.map((r) => `(${String(r.def).replace(/^CHECK /, '')})`).join(' AND ');
      const r = await owner.query(`SELECT ${expr} AS ok FROM (SELECT $1::text AS executor, $2::int AS executor_run, $3::int AS executor_finished_run) v`, [executor, run, finished]);
      return r.rows[0].ok;
    };
    expect(await holds('core', 0, 0)).toBe(true);
    expect(await holds('restate', 2, 1)).toBe(true);
    expect(await holds('restate', 2, 2)).toBe(true);
    expect(await holds('someone', 0, 0)).toBe(false);
    expect(await holds('restate', 1, 2)).toBe(false);
    expect(await holds('restate', -1, 0)).toBe(false);
  });

  it('can run twice (psql by hand after the runner)', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../migrations/022_publication_executor.sql', import.meta.url), 'utf8');
    await owner.query(text);
    const r = await owner.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'hawa.publications'::regclass AND conname LIKE 'publications_executor%'`);
    expect(r.rows[0].n).toBe(2);
  });
});
