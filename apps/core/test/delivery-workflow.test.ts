import { syntheticUnchangedCanvaVersion } from './fixtures/synthetic-canva-version.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, OutboxRepository, PublicationRepository, sql, withRlsContext } from '@hawa/db';
import type { DeliveryInput, DeliveryOutcome, OutboundMessage, SendResult } from '@hawa/contracts';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { coreInternalFromEnv, runDelivery, type CoreInternal } from '../../worker/src/lifecycle/delivery.js';
import { handleSend, type TelegramSenderDeps } from '../../worker/src/lifecycle/telegram-sender.js';
import { readStoredExportBytes, type TelegramSender as BridgeLike } from '../../worker/src/delivery-notification.js';
import { OutboxConsumer } from '../../worker/src/outbox-consumer.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Slice 2.2 of the architecture programme (PHASE2_DESIGN.md section 3, ADR-034/052): a task pinned
 * to Restate at creation is delivered by the Delivery workflow, which
 * prepares through Core, sends the files and the notice through TelegramSender, and reports back.
 *
 * Restate is stood in for at its ingress (the one fetch Core makes to it): a start is recorded, a
 * second start of one workflow key is answered 409 as Restate does, and the test runs the recorded
 * workflow with the worker's own code (runDelivery, handleSend with real send marks and the stored
 * export bytes), calling Core's internal endpoints in process with the worker's token.
 */
// A non-lifecycle task pinned 'restate' (ADR-052) is delivered by the Delivery workflow reporting to
// Core (reportTo 'core'). None exists in production (LEGACY_PATH_RETIREMENT.md); stage 2 of ADR-135
// deletes this path. HAWA_LIFECYCLE_CHATS, which these tests once set, no longer exists.
describe.skipIf(!url)('slice 2.2: Deliver hands a workflow-pinned task to the Delivery workflow', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const OFFICE = '9000001';
  const INGRESS = 'http://restate.test:8080';
  const CORE = 'http://core.test';
  const workerToken = ['worker', 'slice', 'token'].join('_');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  const saved = { ...process.env };
  afterAll(() => db.destroy());
  beforeEach(() => {
    process.env.HAWA_WORKER_TOKEN = workerToken;
    process.env.RESTATE_INGRESS_URL = INGRESS;
    process.env.HAWA_CORE_INTERNAL_URL = CORE;
    process.env.TELEGRAM_ALLOWED_USERS = OFFICE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ['HAWA_WORKER_TOKEN', 'RESTATE_INGRESS_URL', 'HAWA_CORE_INTERNAL_URL', 'TELEGRAM_ALLOWED_USERS']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  type Publisher = { publish: ReturnType<typeof vi.fn> };
  /** Drive and Sheets both confirm, as the office's Google account does when it is connected. */
  const archivingPublisher = (): Publisher => ({
    publish: vi.fn(async (_ctx: unknown, req: any) => ({
      ok: true,
      value: {
        publicationId: randomUUID(), publicationKey: req.publicationKey,
        driveFolderId: req.destination.productionRootFolderId,
        state: 'complete',
        driveFiles: req.files.map((f: any) => ({
          artifactId: f.artifactId, fileId: `drv_${f.artifactId.slice(0, 8)}`, name: f.filename, mimeType: f.mimeType,
          expectedSha256: f.sha256, observedSize: f.byteSize, verified: true, folderId: req.destination.productionRootFolderId,
        })),
        sheet: { spreadsheetId: req.destination.spreadsheetId, sheetId: 0, rowKey: req.taskId,
          rowNumber: 12, expectedHash: req.packageHash, observedHash: req.packageHash, synced: true },
      },
    })),
  });
  /** The office Google account is not connected: nothing reaches Drive. */
  const noDrivePublisher = (): Publisher => ({
    publish: vi.fn(async () => ({ ok: false, error: { code: 'CREDENTIALS_MISSING', message: 'Google Workspace credentials not configured' } })),
  });

  const core = (publisher: Publisher = archivingPublisher()) => createAppWithClientFixtures({
    testAuth: { roleHeader: true },
    db,
    deliverableStore: syntheticUnchangedCanvaVersion(canvaDeliverableStore(new CanvaConnectService(db))),
    publisher,
    telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) },
  } as any);

  /** Restate's ingress: starts recorded, a key started twice answered 409, workflow outputs kept. */
  function fakeRestate() {
    const starts: DeliveryInput[] = [];
    const seen = new Set<string>();
    const outputs = new Map<string, DeliveryOutcome>();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const target = String(input instanceof Request ? input.url : input);
      if (!target.startsWith(INGRESS)) return real(input, init);
      const start = /\/Delivery\/([^/]+)\/run\/send$/.exec(target);
      if (start) {
        const id = decodeURIComponent(start[1]);
        starts.push(JSON.parse(String(init?.body)));
        if (seen.has(id)) return new Response(JSON.stringify({ message: 'workflow already started' }), { status: 409 });
        seen.add(id);
        return new Response(JSON.stringify({ invocationId: `inv_${id}`, status: 'Accepted' }), { status: 200 });
      }
      const output = /\/restate\/workflow\/Delivery\/([^/]+)\/output$/.exec(target);
      if (output) {
        const done = outputs.get(decodeURIComponent(output[1]));
        return done ? new Response(JSON.stringify(done), { status: 200 }) : new Response('{"message":"not ready"}', { status: 470 });
      }
      return new Response('not found', { status: 404 });
    });
    return { starts, outputs };
  }

  /** The requester's and the office's Telegram, as the bot sees it. */
  function fakeTelegram(answer: (chatId: string, kind: 'text' | 'document', filename?: string) => { success: boolean; error?: string } = () => ({ success: true })) {
    const received: Array<{ chatId: string; kind: 'text' | 'document'; filename?: string; text?: string; sha256?: string }> = [];
    let id = 100;
    const bridge: BridgeLike = {
      async dispatchOutboundMessage(chatId, message) {
        const a = answer(String(chatId), 'text');
        if (a.success || a.error === 'TELEGRAM_DELIVERY_UNCERTAIN') received.push({ chatId: String(chatId), kind: 'text', text: message.text });
        return a.success ? { success: true, messageId: String(++id) } : { success: false, error: a.error };
      },
      async dispatchOutboundDocument(chatId, bytes, filename) {
        const a = answer(String(chatId), 'document', filename);
        if (a.success || a.error === 'TELEGRAM_DELIVERY_UNCERTAIN') received.push({ chatId: String(chatId), kind: 'document', filename, sha256: createHash('sha256').update(bytes).digest('hex') });
        return a.success ? { success: true, messageId: String(++id) } : { success: false, error: a.error };
      },
    };
    return { bridge, received };
  }

  /** The worker: runs a recorded Delivery input with its own code against this Core. */
  function worker(app: ReturnType<typeof core>, telegram: ReturnType<typeof fakeTelegram>, options: { core?: CoreInternal } = {}) {
    const deps: TelegramSenderDeps = {
      db,
      botToken: () => ['bot', 'token'].join('_'),
      bridge: () => telegram.bridge,
      readExportBytes: readStoredExportBytes,
      officeChatId: () => OFFICE,
      markRetryDelaysMs: [10],
    };
    // A one-way send to another chat's TelegramSender carries the message's key as its idempotency
    // key, so Restate starts it once however often it is asked for: kept here by key.
    const forwarded = new Set<string>();
    const send = async (m: OutboundMessage): Promise<SendResult> => handleSend({
      run: (_name, action) => action(),
      sendTo: (alert) => {
        if (forwarded.has(alert.key)) return;
        forwarded.add(alert.key);
        void send(alert);
      },
    }, deps, m);
    const coreApi = options.core ?? coreInternalFromEnv(((input: any, init: any) => app.request(String(input), init)) as typeof fetch);
    return (input: DeliveryInput) => runDelivery({ run: (_name, action) => action(), send }, coreApi, input);
  }

  /** KAAE's DNA with a Drive folder and a sheet, saved once through the API as the office does. */
  let destinationSaved = false;
  async function saveKaaeDestination(app: ReturnType<typeof core>) {
    if (destinationSaved) return;
    await (app as any).clientDnaHydrated;
    const current = await (await app.request(`/v1/clients/${kaae}/dna`, { headers })).json();
    const saved = await app.request(`/v1/clients/${kaae}/dna`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...current, destinations: { ...(current.destinations || {}), productionFolderId: 'kaae-slice22-folder', spreadsheetId: 'kaae-slice22-sheet' } }),
    });
    if (![200, 201].includes(saved.status)) throw new Error(`DNA save: ${saved.status} ${await saved.text()} from ${JSON.stringify(current).slice(0, 400)}`);
    destinationSaved = true;
  }

  /**
   * An approved task with two pinned exports and no request owner. `origin` 'desk' is a Desk task,
   * the only kind Core's own delivery still delivers; 'telegram' is one the retired Telegram intake
   * made outside RequestLifecycle (ADR-135 stage 2d refuses to deliver it).
   */
  async function approvedTask(app: ReturnType<typeof core>, deliveryExecutorPin: 'core' | 'restate' = 'core', origin: 'desk' | 'telegram' = 'desk') {
    await saveKaaeDestination(app);
    const taskId = randomUUID();
    const chat = String(60_000_000 + Math.floor(Math.random() * 9_000_000));
    const designId = `canva_slice22_${randomUUID().slice(0, 8)}`;
    const ids = { png: randomUUID(), pptx: randomUUID() };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const { bytes: deck, contentCheck } = await checkedCanvaExportFixture('x');
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, delivery_executor_pin, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Slice 2.2 delivery', 'x', 'received', 3, 1, ${deliveryExecutorPin}, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: origin === 'telegram'
            ? { sourcePlatform: 'telegram', sourceChannelId: chat, copyEn: 'x' }
            : { sourcePlatform: 'hawa_desk', sourceChannelId: 'hawa_desk', copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      for (const [format, bytes, id] of [['png', png, ids.png], ['pptx', deck, ids.pptx]] as const) {
        const op = randomUUID();
        await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
          VALUES (${op}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operator.userId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format, designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
            ${format === 'pptx' ? JSON.stringify(contentCheck) : null}::jsonb, now())`.execute(trx);
      }
    });
    expect((await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId, notifyRequester: false }),
    })).status).toBe(200);
    const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
    const approve = await app.request(`/tasks/${taskId}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' }, body: JSON.stringify({ decision: 'approved', pinnedExportIds: [ids.png, ids.pptx] }),
    });
    expect(approve.status).toBe(201);
    return { taskId, chat, sha256: { png: createHash('sha256').update(png).digest('hex'), pptx: createHash('sha256').update(deck).digest('hex') } };
  }

  const deliver = (app: ReturnType<typeof core>, taskId: string) =>
    app.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ destination: 'google_drive' }) });
  const taskState = async (taskId: string) =>
    (await withRlsContext(db, operator, (trx) => sql<{ state: string }>`SELECT state::text AS state FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx))).rows[0]?.state;
  const publications = async (taskId: string) =>
    (await withRlsContext(db, operator, (trx) => sql<{ state: string; executor: string; executor_run: number; executor_finished_run: number }>`
      SELECT state::text AS state, executor, executor_run, executor_finished_run FROM hawa.publications WHERE task_id = ${taskId}::uuid`.execute(trx))).rows;
  const publishedCommands = async (taskId: string) =>
    (await withRlsContext(db, operator, (trx) => sql<{ state: string; last_error: string | null }>`
      SELECT state::text AS state, last_error FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.published'`.execute(trx))).rows;

  it('a Core-pinned task: Deliver runs Core\'s own delivery exactly as before', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId } = await approvedTask(app);
    const res = await deliver(app, taskId);
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('COMPLETE');
    expect(restateIngress.starts).toEqual([]);
    expect(await taskState(taskId)).toBe('complete');
    expect((await publications(taskId)).map((p) => [p.state, p.executor])).toEqual([['complete', 'core']]);
    // Core's own delivery sends nothing to a requester (ADR-135 stage 2d).
    expect(await publishedCommands(taskId)).toEqual([]);
  });

  it('a Core-pinned task stays on Core at its first delivery', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId } = await approvedTask(app);
    const res = await deliver(app, taskId);
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('COMPLETE');
    expect(restateIngress.starts).toHaveLength(0);
    expect((await publications(taskId)).map((p) => p.executor)).toEqual(['core']);
  });

  // Stage 2 of ADR-135 removed the Delivery workflow for tasks RequestLifecycle does not own. One
  // still pinned to it is refused by both publish routes, and nothing starts or is sent.
  it('a task pinned to the workflow that RequestLifecycle does not own is refused, and nothing starts', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId } = await approvedTask(app, 'restate');
    const direct = await app.request(`/tasks/${taskId}/publish-omnichannel`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    expect(direct.status).toBe(409);
    expect((await direct.json()).detail).toMatch(/Delivery workflow/);
    const res = await deliver(app, taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ title: 'Delivery Workflow Retired' });
    expect(restateIngress.starts).toHaveLength(0);
    expect(await publications(taskId)).toHaveLength(0);
    expect(await publishedCommands(taskId)).toEqual([]);
    expect(await taskState(taskId)).toBe('approved');
  });

  it('a delivery Core\'s own path started stays Core\'s', async () => {
    const restateIngress = fakeRestate();
    const app = core(noDrivePublisher());
    const { taskId } = await approvedTask(app);
    const first = await deliver(app, taskId);
    // Drive refused: the failure is answered and nothing goes to a requester (ADR-135 stage 2d).
    expect(first.status).toBe(422);
    expect((await first.json()).detail).toMatch(/credentials not configured/);
    const again = await deliver(app, taskId);
    expect(again.status).toBe(503);
    expect((await again.json()).detail).toMatch(/archive may already exist/i);
    expect(restateIngress.starts).toEqual([]);
    expect((await publications(taskId)).map((p) => p.executor)).toEqual(['core']);
    expect(await publishedCommands(taskId)).toEqual([]);
  });

  // ADR-135 stage 2d: Core's own delivery no longer sends files to a Telegram requester, and every
  // Telegram request is RequestLifecycle's. A Telegram task the retired intake made outside it is
  // refused before any effect, rather than archived with its requester never told.
  it('a Telegram task outside RequestLifecycle is refused before any effect (LEGACY_TELEGRAM_DELIVERY_RETIRED)', async () => {
    const restateIngress = fakeRestate();
    const publisher = archivingPublisher();
    const app = core(publisher);
    const { taskId } = await approvedTask(app, 'core', 'telegram');
    const res = await deliver(app, taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ title: 'Telegram Delivery Retired', detail: expect.stringMatching(/outside RequestLifecycle/) });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(restateIngress.starts).toEqual([]);
    expect(await publications(taskId)).toEqual([]);
    const reservations = (await withRlsContext(db, operator, (trx) => sql<{ n: number }>`
      SELECT count(*)::int AS n FROM hawa.drive_upload_reservations r JOIN hawa.publications p ON p.id = r.publication_id
      WHERE p.task_id = ${taskId}::uuid`.execute(trx))).rows[0].n;
    expect(reservations).toBe(0);
    expect(await publishedCommands(taskId)).toEqual([]);
    expect(await taskState(taskId)).toBe('approved');
  });

  describe('the internal endpoints', () => {
    const prepare = (app: ReturnType<typeof core>, taskId: string, approvalId: string, authorization: string | null, body: Record<string, unknown> = {}) =>
      app.request(`/v1/internal/lifecycle/${taskId}/deliveries/${approvalId}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ taskId, tenantId, ...body }),
      });

    it('take the worker token only: the operator, the art director and nobody are refused', async () => {
      const app = core();
      const taskId = randomUUID();
      const approvalId = randomUUID();
      for (const authorization of [null, headers.Authorization, 'Bearer test_art_director_bearer', 'Bearer not-the-token']) {
        expect((await prepare(app, taskId, approvalId, authorization)).status).toBe(401);
      }
      // With the worker's token: a task that is not there (or not in the tenant) is not found.
      expect((await prepare(app, taskId, approvalId, `Bearer ${workerToken}`)).status).toBe(404);
    });

    it('refuse to prepare a task RequestLifecycle does not own (stage 2 of ADR-135), whatever its pin', async () => {
      const app = core();
      for (const pin of ['core', 'restate'] as const) {
        const { taskId } = await approvedTask(app, pin);
        const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
        const res = await prepare(app, taskId, detail.latestApproval?.decisionId || randomUUID(), `Bearer ${workerToken}`);
        expect(res.status, pin).toBe(409);
        expect((await res.json()).code).toBe('LEGACY_WORKFLOW_DELIVERY_RETIRED');
      }
      const route = await app.request(`/v1/internal/tasks/${randomUUID()}/delivery-finished`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` }, body: '{}' });
      expect(route.status).toBe(404);
    });

  });
});
