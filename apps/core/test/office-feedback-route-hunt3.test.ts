import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * Hunt-3: POST /tasks/:taskId/feedback writes hawa.feedback_events, the table client learning reads.
 * It stored whatever the body said: a learning-source category, any polarity, a revision of some
 * other task, any length of text, and a display name of the caller's choosing.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(async () => { await db.destroy(); });
const tenantId = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const, displayName: 'Signed-in Operator' };
const app = createApp({ db, testAuth: { principal: scope } });
const post = (path: string, body: unknown) => app.request(`/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function task(): Promise<string> {
  const res = await post('/tasks', { title: 'Feedback probe', clientId: 'c1000000-0000-4000-8000-000000000002', copyEn: 'Probe' });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

describe('operator feedback on a task (hunt-3)', () => {
  it('refuses a category outside the feedback categories (learning-source categories included) and an unknown polarity', async () => {
    const id = await task();
    for (const body of [{ category: 'client_rule_instruction', comment: 'x' }, { category: 'design_refinement', comment: 'x' },
      { category: { x: 1 }, comment: 'x' }, { polarity: 'evil', comment: 'x' }, { comment: 'x'.repeat(4001) }]) {
      const res = await post(`/tasks/${id}/feedback`, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(422);
    }
  });
  it('refuses a revision that is not this task\'s', async () => {
    const id = await task();
    const res = await post(`/tasks/${id}/feedback`, { revisionId: randomUUID(), category: 'layout', comment: 'Tighter margins' });
    expect(res.status).toBe(404);
  });
  it('attributes it to the signed-in caller whatever the body says', async () => {
    const id = await task();
    const res = await post(`/tasks/${id}/feedback`, { category: 'typography', polarity: 'negative', comment: 'Heavier title', displayName: 'The Director' });
    expect(res.status).toBe(201);
    expect((await res.json()).feedback).toMatchObject({ category: 'typography', polarity: 'negative', attributedActor: { displayName: 'Signed-in Operator' } });
  });
});
