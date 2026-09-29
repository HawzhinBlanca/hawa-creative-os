import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { deskReviewTarget } from '@hawa/contracts/desk-navigation';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { randomUUID } from 'node:crypto';
import { searchResultUrl } from '../src/routes/search.routes.js';

/**
 * Bug hunt 2026-09-29, remaining gaps 1 and 2: the search read the tenant's newest 1,000 tasks and
 * filtered them by client and words afterwards, so an older task could not be found, even in a
 * search scoped to its own client; and every hit that was not a task or a client opened the generic
 * review page.
 */
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());
afterEach(() => vi.unstubAllEnvs());

const TENANT = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const HAWA_STUDIO = 'c1000000-0000-4000-8000-000000000001';
const json = { 'Content-Type': 'application/json' };
const core = () => createApp({ db: testDb, testAuth: { principal: { role: 'art_director' } } });

async function newTask(title: string, clientId: string): Promise<string> {
  const res = await core().request('/v1/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title, clientId }) });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

/** `count` tasks of `clientId`, each newer than every task before this call. */
async function newerTasks(count: number, clientId: string): Promise<void> {
  await withRlsContext(testDb, scope, (trx) => sql`
    INSERT INTO hawa.tasks (tenant_id, client_id, title, created_at, updated_at)
    SELECT ${TENANT}::uuid, ${clientId}::uuid, 'Filler request ' || g,
      clock_timestamp() + g * interval '1 millisecond', clock_timestamp()
    FROM generate_series(1, ${count}) AS g`.execute(trx));
}

async function search(params: Record<string, string>) {
  const res = await core().request(`/v1/search?${new URLSearchParams(params)}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ results: Array<{ id: string; url: string | null }>; total: number; truncated: boolean }>;
}

describe('the search reads every task in scope, not the newest 1,000', () => {
  it('finds a task older than 1,000 newer ones, scoped to its client and unscoped', async () => {
    const old = await newTask('Qandilautumn accreditation evening', KAAE);
    await newerTasks(1005, HAWA_STUDIO);

    const scoped = await search({ q: 'Qandilautumn', clientId: KAAE });
    expect(scoped.results.map((r) => r.id)).toContain(old);
    expect(scoped.truncated).toBe(false);
    const found = scoped.results.find((r) => r.id === old)!;
    expect(deskReviewTarget(found.url!)).toMatchObject({ taskId: old });

    const everywhere = await search({ q: 'Qandilautumn' });
    expect(everywhere.results.map((r) => r.id)).toContain(old);
    expect(everywhere.truncated).toBe(false);

    // A search scoped to another client still keeps it out (FR-011).
    expect((await search({ q: 'Qandilautumn', clientId: HAWA_STUDIO })).results.map((r) => r.id)).not.toContain(old);
  }, 60_000);

  it('says when more tasks are in scope than one search reads', async () => {
    await newerTasks(30, HAWA_STUDIO);
    vi.stubEnv('HAWA_SEARCH_TASK_CEILING', '10');
    const capped = await search({ q: 'Filler', clientId: HAWA_STUDIO });
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(10);
    vi.stubEnv('HAWA_SEARCH_TASK_CEILING', '1000000');
    expect((await search({ q: 'Filler', clientId: HAWA_STUDIO })).truncated).toBe(false);
  }, 60_000);

  it('answers an unknown client with nothing, not with every client', async () => {
    await newTask('Zagrosspring open day', KAAE);
    const unknown = await search({ q: 'Zagrosspring', clientId: 'no-such-client' });
    expect(unknown.results).toEqual([]);
  });
});

describe('each hit opens where the Desk shows it', () => {
  it('opens tasks, clients and rules on their pages, navigation on its screen, and an asset nowhere', () => {
    const task = '5f94e0e3-4934-4490-9c1f-44147a0e66b6';
    expect(deskReviewTarget(searchResultUrl({ id: task, category: 'tasks', clientId: KAAE })!)).toMatchObject({ taskId: task });
    expect(searchResultUrl({ id: KAAE, category: 'clients', clientId: KAAE })).toBe(`#/dna?client=${KAAE}`);
    expect(searchResultUrl({ id: 'rule-1', category: 'rules', clientId: KAAE })).toBe(`#/dna?client=${KAAE}`);
    expect(searchResultUrl({ id: 'nav-ops', category: 'copy', clientId: 'all' })).toBe('#/ops');
    expect(searchResultUrl({ id: 'nav-inbox', category: 'copy', clientId: 'all' })).toBe('#/inbox');
    // No Desk screen lists uploaded assets; the generic review page did not show them either.
    expect(searchResultUrl({ id: 'asset-1', category: 'assets', clientId: KAAE })).toBeNull();
  });

  it('answers a navigation hit with its own screen through the route', async () => {
    const nav = await search({ q: 'Operations' });
    expect(nav.results.find((r) => r.id === 'nav-ops')?.url).toBe('#/ops');
    expect(nav.results.some((r) => r.url === '#/review' && r.id !== 'nav-review')).toBe(false);
  });
});

// The audited six-photo task used a generic title; its actual copy lived in the saved request.
describe('request and exact-copy search before the bounded read', () => {
  it('finds an older saved request and exact copy beyond the ceiling without crossing clients', async () => {
    const intake = await persistChatIntake(testDb, { platform:'telegram', sourceEventId:randomUUID(),
      sourceChannelId:`search-${randomUUID()}`, clientId:KAAE, title:'Here is the text',
      rawText:'Field visit report Qandiluniquereport', designInstructions:'Use supplied photographs',
      exactCopy:['Uncommonexactcopytext', 'كردي ١٢٣'] });
    await newerTasks(30, KAAE);
    vi.stubEnv('HAWA_SEARCH_TASK_CEILING', '10');
    for (const q of ['Qandiluniquereport','Uncommonexactcopytext','کردی 123']) {
      expect((await search({q,clientId:KAAE})).results.map(hit=>hit.id)).toContain(intake.task.id);
      expect((await search({q,clientId:HAWA_STUDIO})).results.map(hit=>hit.id)).not.toContain(intake.task.id);
    }
    expect((await search({q:'Qandiluniquereport',clientId:KAAE})).truncated).toBe(false);
  });
});
