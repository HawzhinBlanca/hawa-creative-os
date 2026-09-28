import { afterAll, describe, expect, it } from 'vitest';
import { CompiledQuery, createDb } from '../../../packages/db/src/index.js';
import { CHAOS_TENANT_ID, seedDeskTasks, seedDeskTasksWith } from '../seed-desk-tasks.js';

/**
 * The load test's queue (scripts/load/seed-desk-tasks.ts) was written against studio-v2's schema at
 * 1c1316d. This branch's migrations 023-064 changed the task, review and approval tables, so the rows
 * are written here into this file's own test clone to show they still fit (ADR-127). The chaos
 * database guard stays on the public entry point.
 */
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

describe('seedDeskTasks refuses anything but the chaos database', () => {
  it('refuses the test server and production before connecting', async () => {
    await expect(seedDeskTasks('postgresql://hawa_owner:x@127.0.0.1:55432/hawa_test', { tasks: 1 })).rejects.toThrow(/chaos database/);
    await expect(seedDeskTasks('postgresql://hawa_owner:x@127.0.0.1:54332/hawa', { tasks: 1 })).rejects.toThrow(/chaos database/);
  });
});

describe.skipIf(!ownerUrl)('seedDeskTasksWith on this branch\'s schema', () => {
  const owner = createDb(ownerUrl!, { max: 1 });
  afterAll(async () => { await owner.destroy(); });
  const count = async (text: string) => Number((await owner.executeQuery<{ n: string }>(CompiledQuery.raw(text, [CHAOS_TENANT_ID]))).rows[0].n);

  it('seeds a queue shaped as production writes it, and a second call adds nothing', async () => {
    const first = await seedDeskTasksWith(owner, { tasks: 60, photoEvery: 20, photoKb: 1 });
    expect(first).toMatchObject({ created: 60, total: 60 });
    expect(await count(`SELECT count(*) AS n FROM hawa.task_events WHERE tenant_id = $1 AND event_type = 'task.created' AND data->>'sourceEventId' LIKE 'load-%'`)).toBe(60);
    // Four in five tasks have a design; each design has one to three revisions with a QC run each.
    expect(await count(`SELECT count(*) AS n FROM hawa.design_documents WHERE tenant_id = $1 AND studio_document_id LIKE 'DAload%'`)).toBe(48);
    expect(await count(`SELECT count(*) AS n FROM hawa.design_revisions r JOIN hawa.design_documents d ON d.id = r.design_document_id WHERE d.tenant_id = $1 AND d.studio_document_id LIKE 'DAload%'`)).toBeGreaterThanOrEqual(48);
    expect(await count(`SELECT count(*) AS n FROM hawa.approvals a JOIN hawa.tasks t ON t.id = a.task_id WHERE t.tenant_id = $1 AND t.title LIKE 'Load request #%'`)).toBeGreaterThan(0);
    // Every seeded task is a legacy (Core-delivered) task, as the load test's unenrolled chats make.
    expect(await count(`SELECT count(*) AS n FROM hawa.tasks WHERE tenant_id = $1 AND title LIKE 'Load request #%' AND delivery_executor_pin <> 'core'`)).toBe(0);
    const second = await seedDeskTasksWith(owner, { tasks: 60 });
    expect(second).toMatchObject({ created: 0, total: 60 });
  }, 60_000);
});
