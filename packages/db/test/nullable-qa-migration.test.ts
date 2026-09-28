import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pg from 'pg';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) {
  throw new Error('Isolated hawa_repair database required');
}

/** The checked-in migration must also work on the earlier production column shape. */
describe.skipIf(!url)('migration 025: honest missing-QA decision references', () => {
  it('upgrades the old non-null columns and installs the approved-row guard', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE hawa.approvals DROP CONSTRAINT approvals_approved_requires_qc');
      await client.query('ALTER TABLE hawa.review_requests ALTER COLUMN qc_run_id SET NOT NULL');
      await client.query('ALTER TABLE hawa.approvals ALTER COLUMN qc_run_id SET NOT NULL');

      const source = readFileSync(new URL('../migrations/025_nullable_nonapproval_qa.sql', import.meta.url), 'utf8');
      const body = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
      await client.query(body);

      const columns = (await client.query<{ table_name: string; attnotnull: boolean }>(`
        SELECT c.relname AS table_name, a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'hawa' AND c.relname IN ('review_requests', 'approvals')
          AND a.attname = 'qc_run_id' ORDER BY c.relname
      `)).rows;
      expect(columns).toEqual([
        { table_name: 'approvals', attnotnull: false },
        { table_name: 'review_requests', attnotnull: false },
      ]);
      const guard = (await client.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM pg_constraint
        WHERE conrelid = 'hawa.approvals'::regclass AND conname = 'approvals_approved_requires_qc'
      `)).rows[0];
      expect(guard?.n).toBe('1');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
});
