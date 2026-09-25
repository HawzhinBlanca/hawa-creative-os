import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { composeCanvaStatusMessage } from '../src/services/canva-status-message.js';
import { parseRequesterAction, answerIndex, questionButtons, composeDesignerHandoff } from '../src/services/requester-actions.js';

/**
 * One question before a change is made, when an ask could mean visibly different designs (ADR-032
 * §2.4, the clarify rule): "less empty space" is bigger photos or bigger text, and a wrong guess
 * costs the requester a round. Otherwise the edit acts and says how it read the ask.
 */
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };

const parentLayout = {
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

const emptier = { ask: 'less empty space', elements: ['all'], restyle: false, possible: true, reason: '', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'], assumption: '', copyEdits: [] };
const moveLogo = { ask: 'move the logo to the left', elements: ['logo'], restyle: false, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] };

const harness = (opts: { asks: unknown[]; clarified?: boolean; frustrated?: boolean }) => {
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
      height: 1350,
      pipelineV3: true,
      instructions: 'x',
      copyBlocks: [{ text: 'MEET KAAE AT\nSAGACON 2026', script: 'latin' }, { text: 'September 25, 2026', script: 'latin' }],
      directed: {
        parentTaskId: randomUUID(),
        revisionDirective: opts.clarified ? 'less empty space, and move the logo left\n\nAsked "Fill the space with what?", the client answered: bigger logo' : 'less empty space, and move the logo left',
        ...(opts.clarified ? { clarified: true } : {}),
      },
    },
  };
  const writes: any[] = [];
  const repo = {
    getRunById: async () => run,
    updateRunStatus: async (_id: string, _t: string, status: string, extra: any = {}) => {
      writes.push({ status, ...extra });
      run.status = status;
      if (extra.stages) run.stages = JSON.stringify(extra.stages);
      return run;
    },
    insertCandidate: async (c: any) => c,
    updateCandidate: async (_id: string, _t: string, u: any) => u,
    getCandidatesForRun: async () => [],
    recordCallStart: async () => ({}),
    finalizeCall: async () => ({}),
  };
  const completeJson = vi.fn(async (params: any) => {
    if (params.schemaName === 'EditTargets') return { data: { targets: ['logo'], asks: opts.asks, frustrated: opts.frustrated === true }, receipt: {} };
    return {
      data: { layout: { ...JSON.parse(JSON.stringify(parentLayout)), logo: { x: 72, y: 1160, width: 168, height: 118 } }, changes: [{ element: 'logo', before: 'right', after: 'left', why: 'asked' }] },
      receipt: {},
    };
  });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  (service as any).repo = repo;
  (service as any).attachedImage = async () => undefined;
  (service as any).imagesForRun = async () => [];
  (service as any).activeRunsOfTask = async () => 0;
  (service as any).earlierAsks = async () => [];
  (service as any).parentWinner = async () => ({ runId: 'parent-run', candidateId: 'parent-cand', layout: JSON.parse(JSON.stringify(parentLayout)), concept: { id: 'c', archetype: 'split-band' } });
  (service as any).createStageContext = (_s: any, r: any) => ({
    runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
    width: 1080, height: 1350, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
    referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true,
  });
  const go = async () => {
    await service.resume(scope as any, run.task_id, run.id);
    return (await service.resume(scope as any, run.task_id, run.id)) as any;
  };
  return { run, writes, completeJson, go };
};

describe('an ask that could mean different designs is asked about once, before anything is paid', () => {
  it('stops before the edit with one question and its answers; the whole request waits for it', async () => {
    const { run, writes, completeJson, go } = harness({ asks: [emptier, moveLogo] });
    const res = await go();
    expect(res).toMatchObject({ status: 'failed', code: 'NEEDS_CLARIFICATION' });
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    const stages = JSON.parse(run.stages);
    expect(stages.directed.refused).toBe('NEEDS_CLARIFICATION');
    expect(stages.directed.clarify).toEqual({ ask: 'less empty space', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'] });
    expect(stages.directed.asks.map((a: any) => a.status)).toEqual(['asked', 'asked']);
    expect(stages.directedFailed).toBeUndefined();
    expect(writes.at(-1).diagnostic).toMatch(/stopped at stage laying_out: A question was sent/);
  });

  it('asks nothing once the requester has answered: the edit is made with the answer in it', async () => {
    const { run, completeJson, go } = harness({ asks: [emptier, moveLogo], clarified: true });
    const res = await go();
    expect(res.code).toBeUndefined();
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets', 'DirectedEdit']);
    const analysis = String((completeJson.mock.calls[0] as any)[0].prompt);
    expect(analysis).toContain('already answered a question about this request');
    expect(analysis).toContain('the client answered: bigger logo');
    expect(JSON.parse(run.stages).directed.clarify).toBeUndefined();
  });

  it('an ask read one way says how it was read, in the note the requester gets', async () => {
    const readAs = { ...emptier, question: '', options: [], assumption: 'the logo made bigger to fill the space' };
    const { run, go } = harness({ asks: [{ ...readAs, elements: ['logo'] }] });
    await go();
    const stages = JSON.parse(run.stages);
    expect(stages.directed.asks).toEqual([{ ask: 'less empty space', status: 'done', by: 'model', assumption: 'the logo made bigger to fill the space' }]);
    expect(requesterDraftNotes({ run, candidates: [] } as any)).toContain('✅ Done: less empty space (read as: the logo made bigger to fill the space).');
  });

  it('a question needs two answers; one answer is acted on, not asked', async () => {
    const { run, go } = harness({ asks: [{ ...emptier, elements: ['logo'], options: ['bigger logo'] }] });
    const res = await go();
    expect(res.code).toBeUndefined();
    expect(JSON.parse(run.stages).directed.asks[0].status).toBe('done');
  });

  it('a requester losing patience is recorded, for the office', async () => {
    const { run, go } = harness({ asks: [moveLogo], frustrated: true });
    await go();
    expect(JSON.parse(run.stages).directed.frustrated).toBe(true);
    const handoff = composeDesignerHandoff({ taskId: run.task_id, title: 'KAAE', asks: [], rounds: 2, why: 'frustrated' });
    expect(handoff.text).toContain('The requester sounds frustrated');
  });
});

describe('the question the requester reads', () => {
  const taskId = '00000000-0000-4000-c000-000000000009';
  it('says nothing was made, lists the answers as buttons, and offers a designer', () => {
    const msg = composeCanvaStatusMessage({
      taskId,
      status: 'DESIGN_REJECTED',
      code: 'NEEDS_CLARIFICATION',
      question: { question: 'Fill the space with what?', options: ['bigger title text', 'bigger <logo>'] },
      notPossible: [{ ask: 'cut the panelists out', reason: 'a designer is needed' }],
    });
    expect(msg.text).toContain('One question before I make your change');
    expect(msg.text).toContain('Fill the space with what?');
    expect(msg.text).toContain('2. bigger &lt;logo&gt;');
    expect(msg.text).toContain('• cut the panelists out (a designer is needed)');
    const data = msg.reply_markup!.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : b.url));
    expect(data).toEqual([`rq:a1:${taskId}`, `rq:a2:${taskId}`, `rq:dsg:${taskId}`]);
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
  });

  it('answer buttons parse back to their number, and nothing past three does', () => {
    expect(parseRequesterAction(`rq:a3:${taskId}`)).toEqual({ action: 'a3', taskId });
    expect(answerIndex('a1')).toBe(0);
    expect(answerIndex('ok')).toBeUndefined();
    expect(parseRequesterAction(`rq:a4:${taskId}`)).toBeNull();
    expect(questionButtons(taskId, ['x'.repeat(80), 'y']).flat()[0].text).toHaveLength(60);
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;

describe.skipIf(!url)('answering the question (webhook, PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const operator = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['clarifying', 'questions', 'fixture'].join('_');
  const OFFICE = 91000004;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    // The test database keeps every run's tasks of the day, so the office-wide daily cap on automatic
    // drafts (200) is reached by the tests themselves; it is not what these tests are about.
    process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  /** A design (the parent) and a change to it that stopped to ask a question: the task paused. */
  const setup = async () => {
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
    const chat = 60000000 + Math.floor(Math.random() * 9000000);
    const post = async (body: unknown) => {
      const res = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const request = async (text: string) => {
      const res = await post({ update_id: randomUUID(), message: { message_id: 1, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, text } });
      expect(res.status).toBe(201);
      return String(res.body.task?.id || res.body.taskId);
    };
    const parent = await request('KAAE members evening\n---\nDecember 4, 2026\nErbil');
    const waiting = await request('KAAE members evening, change\n---\nDecember 4, 2026\nErbil');
    await withRlsContext(db, operator, async (trx) => {
      await sql`UPDATE hawa.outbox_commands SET payload = jsonb_set(payload, '{studioOptions}', COALESCE(payload->'studioOptions', '{}'::jsonb)
          || jsonb_build_object('parentTaskId', ${parent}::text, 'revisionDirective', 'less empty space', 'revisionRound', 1))
        WHERE aggregate_id = ${waiting}::uuid AND command_type = 'task.created'`.execute(trx);
      await sql`UPDATE hawa.tasks SET state = 'paused' WHERE id = ${waiting}::uuid`.execute(trx);
      const stages = { directed: { refused: 'NEEDS_CLARIFICATION', asks: [{ ask: 'less empty space', status: 'asked' }], clarify: { ask: 'less empty space', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'] } } };
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        SELECT ${randomUUID()}::uuid, t.tenant_id, t.id, t.client_id, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'failed', ${JSON.stringify(stages)}::jsonb
        FROM hawa.tasks t WHERE t.id = ${waiting}::uuid`.execute(trx);
    });
    const press = (data: string, inChat = chat) =>
      post({ update_id: randomUUID(), callback_query: { id: randomUUID(), from: { id: OFFICE, is_bot: false }, message: { message_id: 5, chat: { id: inChat, type: 'private' } }, data } });
    const created = async (after: string) =>
      (await withRlsContext(db, operator, async (trx) =>
        (await sql<{ id: string; options: any; state: string }>`SELECT t.id::text AS id, o.payload->'studioOptions' AS options, t.state::text AS state FROM hawa.tasks t
          JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
          WHERE o.payload->'studioOptions'->>'parentTaskId' = ${parent} AND t.id <> ${after}::uuid`.execute(trx)).rows));
    const stateOf = async (id: string) =>
      (await withRlsContext(db, operator, async (trx) => (await sql<{ state: string }>`SELECT state::text AS state FROM hawa.tasks WHERE id = ${id}::uuid`.execute(trx)).rows[0].state));
    return { chat, parent, waiting, press, post, dispatch, created, stateOf };
  };

  it('a tapped answer starts the change again on the same design, never to be asked again; the waiting task closes', async () => {
    const { parent, waiting, press, dispatch, created, stateOf } = await setup();
    const res = await press(`rq:a2:${waiting}`);
    expect(res.body).toMatchObject({ ok: true, requesterAction: 'a2', taskId: waiting });
    const [revision] = await created(waiting);
    expect(revision.id).toBe(res.body.revisionTaskId);
    expect(revision.options).toMatchObject({ parentTaskId: parent, revisionRound: 1, clarified: true });
    expect(revision.options.revisionDirective).toBe('less empty space\n\nAsked "Fill the space with what?", the client answered: bigger logo');
    expect(await stateOf(waiting)).toBe('cancelled');
    expect(String(dispatch.mock.calls.at(-1)?.[1]?.text)).toContain('Got it:</b> bigger logo');
    const again = await press(`rq:a1:${waiting}`);
    expect(again.body).toMatchObject({ already: true });
    expect((await created(waiting)).length).toBe(1);
  });

  it('a reply in the requester\'s own words is the answer too, and a button from another chat does nothing', async () => {
    const { chat, waiting, press, post, created } = await setup();
    expect((await press(`rq:a1:${waiting}`, chat + 1)).body).toMatchObject({ ok: false, reason: 'NOT_THIS_CHAT' });
    const reply = await post({
      update_id: randomUUID(),
      message: {
        message_id: 9, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' },
        text: 'make the photos bigger please',
        reply_to_message: { message_id: 8, from: { id: 1, is_bot: true }, chat: { id: chat, type: 'private' }, text: `One question before I make your change\n\nTask ID: ${waiting}` },
      },
    });
    expect(reply.body).toMatchObject({ ok: true, status: 'QUESTION_ANSWERED', taskId: waiting });
    const [revision] = await created(waiting);
    expect(revision.options.revisionDirective).toContain('the client answered: make the photos bigger please');
    expect(revision.options.clarified).toBe(true);
  });
});
