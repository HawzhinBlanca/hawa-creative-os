import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { TASK_TRANSITIONED_KEYS, parseTaskTransitioned } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * task:transitioned on the Desk's live stream (architecture programme 1.2). It had four payload
 * shapes ({status}, {fromStatus, toStatus}, {action}, mixes) and sent database words upper-cased
 * ('HUMAN_REVIEW', 'FAILED_OPERATOR'), which the Desk did not know. Each event is now
 * {taskId, from, to, version, at} in the shared API statuses, with the version the move wrote.
 * Runs against hawa-test-postgres as hawa_app.
 */
describe('task:transitioned payloads (PostgreSQL)', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
  const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  afterAll(() => db.destroy());

  const beingMade = async (title: string) => {
    const taskId = (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: String(7_000_000_000 + Math.floor(Math.random() * 999_999_999)),
        clientId: kaae,
        title,
        rawText: 'KAAE members evening\n---\nDecember 4, 2026\nErbil',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'KAAE members evening' }],
        autoGenerate: false,
      } as any)
    ).task.id as string;
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.tasks SET state = 'studio_composition' WHERE id = ${taskId}::uuid`.execute(trx));
    return taskId;
  };

  /** The task:transitioned payloads naming `taskId` on the live stream while `notify` is posted. */
  const movesDuring = async (taskId: string, notify: Record<string, unknown>) => {
    const telegramBridge = { dispatchOutboundMessage: async () => ({ success: true }), dispatchOutboundPhoto: async () => ({ success: true }) };
    const app = createApp({ db, telegramBridge } as any);
    const stream = await app.request('/v1/events/stream', { headers: operator });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let seen = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        seen += new TextDecoder().decode(value);
      }
    })();
    const res = await app.request(`/v1/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST',
      headers: operator,
      body: JSON.stringify({ ...notify, notifyRequester: false }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    await reader.cancel().catch(() => undefined);
    await pump;
    const version = Number(
      (await withRlsContext(db, scope, (trx) => sql<{ version: number }>`SELECT version FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx))).rows[0].version
    );
    const moves = seen
      .split('\n\n')
      .filter((block) => /event: task:transitioned/.test(block) && block.includes(taskId))
      .map((block) => JSON.parse(/data: (.*)/.exec(block)![1]));
    return { moves, version };
  };

  it('a run that ended with no draft: {taskId, from, to, version, at} with COMPOSING -> OPERATOR_REQUIRED', async () => {
    const taskId = await beingMade('KAAE: members evening (event shape, failed)');
    const { moves, version } = await movesDuring(taskId, { status: 'GENERATION_FAILED' });
    expect(moves).toHaveLength(1);
    const { tenantId: streamTenant, ...payload } = moves[0];
    expect(streamTenant).toBe(tenantId);
    expect(Object.keys(payload).sort()).toEqual([...TASK_TRANSITIONED_KEYS].sort());
    expect(payload).toMatchObject({ taskId, from: 'COMPOSING', to: 'OPERATOR_REQUIRED', version });
    expect(new Date(payload.at).toISOString()).toBe(payload.at);
    expect(parseTaskTransitioned(moves[0])).not.toBeNull();
  });

  it('a delivered draft: one move COMPOSING -> AWAITING_APPROVAL, never an upper-cased database word', async () => {
    const taskId = await beingMade('KAAE: members evening (event shape, draft)');
    const { moves, version } = await movesDuring(taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGshapeLive01' });
    const parsed = moves.map((m) => parseTaskTransitioned(m));
    expect(parsed).toEqual([{ taskId, from: 'COMPOSING', to: expect.any(String), version: expect.any(Number), at: expect.any(String) }]);
    // Review when the draft became a Desk revision; the operator when it could not (both are logged).
    expect(['AWAITING_APPROVAL', 'OPERATOR_REQUIRED']).toContain(parsed[0]!.to);
    // The version the move wrote; recording the revision in the same transaction can raise it again.
    expect(parsed[0]!.version).toBeLessThanOrEqual(version);
    expect(JSON.stringify(moves)).not.toMatch(/STUDIO_COMPOSITION|FAILED_OPERATOR|HUMAN_REVIEW|CHANGES_REQUESTED/);
  });

  it('publication-state reports the stored status of a task Core does not hold in memory, never PENDING', async () => {
    // After a restart no task is in memory; the route used to answer 'PENDING', a word outside the vocabulary.
    const taskId = await beingMade('KAAE: members evening (publication state)');
    const app = createApp({ db } as any);
    const res = await app.request(`/v1/tasks/${taskId}/publication-state`, { headers: operator });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('COMPOSING');
    expect(body.state).toBe('unstarted');
  });
});
