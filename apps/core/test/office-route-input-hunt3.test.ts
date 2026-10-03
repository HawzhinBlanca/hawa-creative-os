import { afterAll, describe, expect, it } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/** Hunt-3: office route input that became a misleading answer instead of a 400 or 404. */
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(async () => { await db.destroy(); });
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };

describe('search paging (hunt-3)', () => {
  const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'operator' } } });
  it('refuses a limit or offset that is not a whole number in range', async () => {
    // limit=x reached the engine as NaN: Math.min(NaN, 200) is NaN, and every hit was sliced away while
    // total still counted them.
    for (const qs of ['limit=x', 'offset=x', 'limit=-1', 'offset=-5', 'limit=1e9']) {
      expect((await app.request(`/v1/search?q=a&${qs}`)).status, qs).toBe(400);
    }
    expect((await app.request('/v1/search?q=a&limit=5&offset=0')).status).toBe(200);
  });
});

describe('a task id that is not an id (hunt-3)', () => {
  const app = createApp({ db, testAuth: { principal: scope } });
  it('is a task not found, not "Database Unavailable"', async () => {
    for (const path of ['/v1/tasks/abc', '/v1/tasks/abc/timeline']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe('a database failure is not echoed to the caller (hunt-3)', () => {
  const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  afterAll(async () => { await owner.destroy(); });
  const app = createApp({ db, testAuth: { principal: scope } });
  it('the task list says the list could not be read, without the database error', async () => {
    await sql.raw('REVOKE SELECT ON hawa.tasks FROM hawa_app').execute(owner);
    let res: Response;
    try { res = await app.request('/v1/tasks'); } finally { await sql.raw('GRANT SELECT ON hawa.tasks TO hawa_app').execute(owner); }
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toMatch(/permission denied|relation|for table/i);
  });
});
