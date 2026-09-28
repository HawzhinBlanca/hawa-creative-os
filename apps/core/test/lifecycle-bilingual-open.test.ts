import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { savedDesignCopy } from '../src/services/canva-design-planner.js';

/**
 * ADR-139: a brief with English copy for one graphic and Kurdish copy for another opens one lifecycle
 * request per language, as legacy intake made one task per language (splitBilingualRequest, task
 * 89c242f2 on 2026-09-19). Before, the lifecycle opened one request whose copy was the Kurdish only:
 * the English copy above the divider was read as instructions, the bug the legacy split had fixed.
 * Through Core's internal intake and projection routes as the worker calls them, against the per-file
 * test database as hawa_app.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000027;
const WORKER = ['worker', 'bilingual', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 64_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
const textUpdate = (chat: number, text: string) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text } };
};

// The owner's message of 2026-09-19 (task 89c242f2), as bilingual-request.test.ts reads it.
const BILINGUAL = `Create a clean, professional bilingual KAAE graphic in English and Kurdish. Add a small gold CTA box near the bottom.
And only use Verdana font.

Here is text to add on each of the kurdish and English graphics:

K-12 STANDARDS FRAMEWORK
EDITION 2.0


Advancing quality and continuous improvement across K-12 education in the Kurdistan Region.


Now available at kaae.org.
_____________________________________
چوارچێوەی ستانداردەکانی پەروەردە (K-12)
چاپی 2.0


بەرزکردنەوەی کوالێتی و بەردەوامی پەرەپێدانی پەروەردە (K-12) لە هەرێمی کوردستان.


ئێستا لە kaae.org بەردەستە`;

const intake = async (app: any, update: unknown, languageSiblings = true) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'legacy', ...(languageSiblings ? { languageSiblings: true } : {}) }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const project = async (app: any, requestId: string, draft: unknown) => {
  const res = await app.request(`/v1/internal/lifecycle/${requestId}/project`, { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`, ops: [{ kind: 'createRequest', draft }] }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const requestsOf = async (chat: number) => (await withRlsContext(db, scope, (trx) => sql<{ request_id: string; owner: string; root_task_id: string }>`
  SELECT request_id::text, owner, root_task_id::text FROM hawa.requests WHERE chat_id = ${String(chat)} ORDER BY request_id`.execute(trx))).rows;

const taskCopy = async (taskId: string) => {
  const [row] = (await withRlsContext(db, scope, (trx) => sql<{ source: unknown; description: string; pin: string; request_id: string }>`
    SELECT (SELECT e.data FROM hawa.task_events e WHERE e.task_id = t.id AND e.event_type = 'task.created' ORDER BY e.aggregate_version LIMIT 1) AS source,
      t.description, t.delivery_executor_pin AS pin, t.request_id::text FROM hawa.tasks t WHERE t.id = ${taskId}::uuid`.execute(trx))).rows;
  return { ...savedDesignCopy(row.source, row.description || ''), pin: row.pin, requestId: row.request_id };
};

describe('an English-and-Kurdish brief on the lifecycle (ADR-139)', () => {
  it('opens one request per language, each with its own task and only its own copy', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db } as any);
    const chat = chatId();
    const update = textUpdate(chat, BILINGUAL);
    const answer = await intake(app, update);
    expect(answer.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(chat) });
    expect(answer.body.siblings).toHaveLength(1);
    const opens = [{ requestId: answer.body.requestId, draft: answer.body.draft }, ...answer.body.siblings];
    expect(new Set(opens.map((o: any) => o.requestId)).size).toBe(2);
    for (const open of opens) expect(open.draft.sourceEventId).toBe(`lc-${open.requestId}-r0`);

    // Replayed (the worker's answer was lost): the same two requests, nothing new decided.
    const replay = await intake(createApp({ db } as any), update);
    expect(replay.body).toMatchObject({ intakeStatus: 200, duplicate: true, requestId: answer.body.requestId, siblings: answer.body.siblings });

    // RequestLifecycle projects each open as the worker's two keyed opens do.
    const tasks: string[] = [];
    for (const open of opens) {
      const projected = await project(app, open.requestId, open.draft);
      expect(projected.status).toBe(200);
      tasks.push(projected.body.taskId ?? projected.body.result?.taskId);
    }
    const requests = await requestsOf(chat);
    expect(requests.map((r) => r.owner)).toEqual(['restate', 'restate']);
    const [en, ckb] = await Promise.all(opens.map(async (o: any) =>
      taskCopy(requests.find((r) => r.request_id === o.requestId)!.root_task_id)));
    expect(en.copy).toEqual([
      'K-12 STANDARDS FRAMEWORK\nEDITION 2.0',
      'Advancing quality and continuous improvement across K-12 education in the Kurdistan Region.',
      'Now available at kaae.org.',
    ]);
    expect(ckb.copy).toHaveLength(3);
    expect(ckb.copy.every((b) => /[؀-ۿ]/.test(b))).toBe(true);
    expect(en.instructions).toContain('English copy only');
    expect(ckb.instructions).toContain('Kurdish copy only');
    for (const side of [en, ckb]) {
      expect(side.instructions).toContain('only use Verdana font');
      expect(side.pin).toBe('restate');
    }
  });

  it('opens one request, as before, for a worker that would open only the first', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const answer = await intake(createApp({ db } as any), textUpdate(chat, BILINGUAL), false);
    expect(answer.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request' });
    expect(answer.body.siblings).toBeUndefined();
  });

  it('never replays a two-language decision to a worker that would open only one: it waits to be parked', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const update = textUpdate(chatId(), BILINGUAL);
    expect((await intake(createApp({ db } as any), update)).body.siblings).toHaveLength(1);
    expect((await intake(createApp({ db } as any), update, false)).body).toMatchObject({ intakeStatus: 503, code: 'LANGUAGE_SIBLINGS_UNSUPPORTED' });
  });

  it('leaves a brief in one language, and a single bilingual graphic, as one request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db } as any);
    for (const text of ['KAAE members evening\n---\nDecember 4, 2026\nErbil',
      'One bilingual poster, both languages on it.\n---\nKAAE members evening\n\nئێوارەی ئەندامانی KAAE']) {
      const answer = await intake(app, textUpdate(chatId(), text));
      expect(answer.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request' });
      expect(answer.body.siblings).toBeUndefined();
    }
  });

  it('gives a photo sent with a bilingual brief to both requests, each projected against the one decision', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const update = textUpdate(chat, '');
    delete (update.message as any).text;
    (update.message as any).caption = BILINGUAL;
    (update.message as any).photo = [{ file_id: 'bilingual-photo', file_size: 128 }];
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => photo), dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const app = createApp({ db, telegramBridge: bridge } as any);
    const answer = await intake(app, update);
    expect(answer.body.siblings).toHaveLength(1);
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(answer.body.siblings[0].draft.lifecycleImage).toEqual(answer.body.draft.lifecycleImage);
    for (const open of [{ requestId: answer.body.requestId, draft: answer.body.draft }, ...answer.body.siblings]) {
      expect((await project(app, open.requestId, open.draft)).status).toBe(200);
    }
    // A draft the decision did not record for that request is refused (the sibling's under the first's id).
    const other = chatId();
    const second = textUpdate(other, '');
    delete (second.message as any).text;
    (second.message as any).caption = BILINGUAL;
    (second.message as any).photo = [{ file_id: 'bilingual-photo-2', file_size: 128 }];
    const forged = await intake(app, second);
    expect((await project(app, forged.body.requestId, { ...forged.body.siblings[0].draft,
      sourceEventId: `lc-${forged.body.requestId}-r0` })).status).toBe(409);
    expect(await requestsOf(chat)).toHaveLength(2);
  });
});
