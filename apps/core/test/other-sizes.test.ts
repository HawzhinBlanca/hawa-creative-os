import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { parseRequesterAction, sizeButtons, composeRequesterApproved, sizeOf } from '../src/services/requester-actions.js';

/**
 * The same design in another size (plan 4.3): after approving a post, the requester can ask for the
 * story, square or landscape version. It is laid out again for the format by the edit, not stretched,
 * and checked by the same gates; it comes back as its own draft.
 */
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
const taskId = '00000000-0000-4000-c000-000000000011';

const post = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [],
  text: [
    { x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    { x: 72, y: 520, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
  logo: { x: 840, y: 1160, width: 168, height: 118 },
} as unknown as StudioLayoutV2;

describe('the size buttons', () => {
  it('offer every other size after approval, and parse back', () => {
    const rows = sizeButtons(taskId, { width: 1080, height: 1080 });
    expect(rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([`rq:sst:${taskId}`, `rq:sls:${taskId}`]);
    expect(parseRequesterAction(`rq:sls:${taskId}`)).toEqual({ action: 'sls', taskId });
    expect(sizeOf('sst')).toMatchObject({ width: 1080, height: 1920, label: 'story' });
    expect(sizeOf('ok')).toBeUndefined();
    const approved = composeRequesterApproved(taskId, { width: 1080, height: 1350 });
    expect(approved.text).toContain('Need it in another size too?');
    expect(JSON.stringify(approved.reply_markup)).toContain(`rq:ssq:${taskId}`);
  });
});

describe('a size run', () => {
  it('lays the approved design out again for the new canvas, asks nothing, and says what it is', async () => {
    // Text and logo inside the story safe zone (y 269 to 1536 on 1920).
    const story = {
      ...JSON.parse(JSON.stringify(post)),
      height: 1920,
      text: [
        { ...post.text[0], y: 420 },
        { ...post.text[1], y: 760 },
      ],
      logo: { x: 456, y: 1360, width: 168, height: 118 },
    };
    const run: any = {
      id: randomUUID(),
      tenant_id: scope.tenantId,
      task_id: randomUUID(),
      client_id: 'c1000000-0000-4000-8000-000000000002',
      actor_id: scope.actorId,
      status: 'conceiving',
      stages: JSON.stringify({ brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }], readingOrder: [0, 1], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC } }),
      budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
      request: {
        width: 1080,
        height: 1920,
        pipelineV3: true,
        instructions: 'x',
        copyBlocks: [{ text: 'MEET KAAE AT\nSAGACON 2026', script: 'latin' }, { text: 'September 25, 2026', script: 'latin' }],
        directed: { parentTaskId: randomUUID(), revisionDirective: 'The same design as a story (1080x1920).', reformat: 'story' },
      },
    };
    const updated: any[] = [];
    const repo = {
      getRunById: async () => run,
      updateRunStatus: async (_id: string, _t: string, status: string, extra: any = {}) => {
        run.status = status;
        if (extra.stages) run.stages = JSON.stringify(extra.stages);
        return run;
      },
      insertCandidate: async (c: any) => c,
      updateCandidate: async (_id: string, _t: string, u: any) => {
        updated.push(u);
        return u;
      },
      getCandidatesForRun: async () => [],
      recordCallStart: async () => ({}),
      finalizeCall: async () => ({}),
    };
    const completeJson = vi.fn(async () => ({ data: { layout: JSON.parse(JSON.stringify(story)), changes: [] }, receipt: {} }));
    const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
    (service as any).repo = repo;
    (service as any).attachedImage = async () => undefined;
    (service as any).imagesForRun = async () => [];
    (service as any).activeRunsOfTask = async () => 0;
    (service as any).earlierAsks = async () => [];
    (service as any).parentWinner = async () => ({ runId: 'parent-run', candidateId: 'parent-cand', layout: JSON.parse(JSON.stringify(post)), concept: { id: 'c', archetype: 'split-band' } });
    (service as any).createStageContext = (_s: any, r: any) => ({
      runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
      width: 1080, height: 1920, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
      referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, pipelineV3: true,
    });
    await service.resume(scope as any, run.task_id, run.id);
    const res: any = await service.resume(scope as any, run.task_id, run.id);
    expect(res.code).toBeUndefined();
    const schemas = completeJson.mock.calls.map((c: any) => c[0].schemaName);
    expect(schemas).toEqual(['DirectedEdit']);
    const prompt = String((completeJson.mock.calls[0] as any)[0].prompt);
    expect(prompt).toContain('Make the same design as a story, on a 1080x1920 canvas');
    expect(prompt).toContain('on a 1080x1350 canvas');
    expect(prompt).toContain("inside the story's safe zone, x 65 to 1015 and y 269 to 1536");
    const layout = updated.find((u) => u.layouts)?.layouts?.[0];
    expect(layout).toMatchObject({ width: 1080, height: 1920 });
    const stages = JSON.parse(run.stages);
    expect(stages.directed).toMatchObject({ reformat: 'story', size: { width: 1080, height: 1920 } });
    expect(requesterDraftNotes({ run, candidates: [] } as any)).toEqual(['📐 Your approved design as a story (1080×1920), laid out again for the format.']);
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;

describe.skipIf(!url)('asking for another size (webhook, PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const operator = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['other', 'sizes', 'fixture'].join('_');
  const OFFICE = 91000005;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    // The test database holds every test's tasks of the day; the caps are not what is tested here.
    process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
    process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000';
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  it('makes the story version once, as its own task of the same design, and the original keeps its buttons', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const bridge = {
      dispatchOutboundMessage: dispatch,
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      downloadFile: vi.fn(),
      handleCommand: vi.fn().mockReturnValue(null),
      formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    };
    const app = createApp({ db, telegramBridge: bridge as any } as any);
    const chat = 50000000 + Math.floor(Math.random() * 9000000);
    const call = async (body: unknown) => {
      const res = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const made = await call({ update_id: randomUUID(), message: { message_id: 1, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' } });
    const design = String(made.body.task?.id || made.body.taskId);
    const press = (data: string) =>
      call({ update_id: randomUUID(), callback_query: { id: randomUUID(), from: { id: OFFICE, is_bot: false }, message: { message_id: 5, chat: { id: chat, type: 'private' } }, data } });

    const approved = await press(`rq:ok:${design}`);
    expect(approved.body).toMatchObject({ requesterAction: 'ok' });
    expect(JSON.stringify(dispatch.mock.calls.at(-1)?.[1]?.reply_markup)).toContain(`rq:sst:${design}`);

    const story = await press(`rq:sst:${design}`);
    expect(story.body).toMatchObject({ ok: true, requesterAction: 'sst', taskId: design });
    const row = await withRlsContext(db, operator, async (trx) =>
      (await sql<{ title: string; payload: any }>`SELECT t.title, o.payload FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.id = ${story.body.sizeTaskId}::uuid`.execute(trx)).rows[0]);
    expect(row.payload.variant).toEqual({ width: 1080, height: 1920 });
    expect(row.payload.studioOptions).toMatchObject({ parentTaskId: design, reformat: 'story' });
    expect(row.payload.exactCopy).toEqual(expect.any(Array));
    expect(row.title).toMatch(/\(story\)$/);
    expect(String(dispatch.mock.calls.at(-1)?.[1]?.text)).toContain('Making the story version (1080×1920)');

    expect((await press(`rq:sst:${design}`)).body).toMatchObject({ already: true });
    // The story task is a format of the design, not a newer version of it: the design's own buttons still act on it.
    const again = await press(`rq:dsg:${design}`);
    expect(again.body.replacedBy).toBeUndefined();
    const change = await press(`rq:chg:${design}`);
    expect(change.body.replacedBy).toBeUndefined();
  });
});
