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
describe.skipIf(!url)('slice 2.2: Deliver hands a flagged chat\'s task to the Delivery workflow', () => {
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
    delete process.env.HAWA_LIFECYCLE_CHATS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ['HAWA_WORKER_TOKEN', 'RESTATE_INGRESS_URL', 'HAWA_CORE_INTERNAL_URL', 'TELEGRAM_ALLOWED_USERS', 'HAWA_LIFECYCLE_CHATS']) {
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
          expectedSha256: f.sha256, observedSize: f.byteSize, verified: true, folderId: 'kaae-folder',
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

  async function approvedTask(app: ReturnType<typeof core>, deliveryExecutorPin: 'core' | 'restate' = 'core') {
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
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: chat, copyEn: 'x' } })}::jsonb, now())`.execute(trx);
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

  it('with HAWA_LIFECYCLE_CHATS empty, Deliver runs Core\'s own delivery exactly as before', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId } = await approvedTask(app);
    const res = await deliver(app, taskId);
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('COMPLETE');
    expect(restateIngress.starts).toEqual([]);
    expect(await taskState(taskId)).toBe('complete');
    expect((await publications(taskId)).map((p) => [p.state, p.executor])).toEqual([['complete', 'core']]);
    // The requester's files go through the outbox, as before.
    expect((await publishedCommands(taskId)).map((c) => c.state)).toEqual(['pending']);
  });

  it('a task created before chat enrolment stays on Core before its first delivery', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId, chat } = await approvedTask(app);
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    const res = await deliver(app, taskId);
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('COMPLETE');
    expect(restateIngress.starts).toHaveLength(0);
    expect((await publications(taskId)).map((p) => p.executor)).toEqual(['core']);
  });

  it('a task pinned to the workflow keeps it after the chat flag is removed, before first delivery', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId } = await approvedTask(app, 'restate');
    delete process.env.HAWA_LIFECYCLE_CHATS;
    const direct = await app.request(`/tasks/${taskId}/publish-omnichannel`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    expect(direct.status).toBe(409);
    expect((await direct.json()).detail).toMatch(/Delivery workflow/);
    expect(await publications(taskId)).toHaveLength(0);
    const res = await deliver(app, taskId);
    expect(res.status).toBe(202);
    expect((await res.json()).executor).toBe('restate');
    expect(restateIngress.starts).toHaveLength(1);
  });

  it('flagged: the workflow sends each file and the notice once, and Core completes the task on its report', async () => {
    const restateIngress = fakeRestate();
    const telegram = fakeTelegram();
    const publisher = archivingPublisher();
    const app = core(publisher);
    const { taskId, chat, sha256 } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = `123,${chat}`;

    const res = await deliver(app, taskId);
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ executor: 'restate', status: 'PUBLISHING', alreadyDelivering: false });
    expect(await taskState(taskId)).toBe('publishing');
    expect((await publications(taskId)).map((p) => [p.state, p.executor, p.executor_run, p.executor_finished_run])).toEqual([['pending', 'restate', 1, 0]]);
    expect(restateIngress.starts).toHaveLength(1);
    const input = restateIngress.starts[0];
    expect(input).toMatchObject({ v: 1, taskId, tenantId, chatId: chat, officeChatId: OFFICE, reportTo: 'core', run: 1, requestId: taskId });
    expect(input.deliveryId).toBe(body.deliveryId);
    expect(input.deliveryId).toBe(`dl-${taskId}-${input.approvalId}`);
    // Nothing for the outbox: the workflow sends the files itself.
    expect(publisher.publish).not.toHaveBeenCalled();

    const outcome = await worker(app, telegram)(input);
    expect(outcome).toEqual({ outcome: 'delivered', uncertain: [], sheetsConfirmed: true, archived: true, filesSent: 2 });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(telegram.received.map((r) => [r.chatId, r.kind, r.sha256 ?? null])).toEqual([
      [chat, 'document', sha256.png], [chat, 'document', sha256.pptx], [chat, 'text', null],
    ]);
    expect(telegram.received[2].text).toContain('The 2 approved files are attached above.');
    expect(await taskState(taskId)).toBe('complete');
    expect((await publications(taskId)).map((p) => [p.state, p.executor, p.executor_run, p.executor_finished_run])).toEqual([['complete', 'restate', 1, 1]]);
    expect(await publishedCommands(taskId)).toEqual([]);

    // Pressed again: the stored delivery, no new run. The same workflow replayed sends nothing again.
    const again = await deliver(app, taskId);
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe('COMPLETE');
    expect(restateIngress.starts).toHaveLength(1);
    await worker(app, telegram)(input);
    expect(telegram.received).toHaveLength(3);
  });

  it('flagged: Deliver pressed again while the workflow runs starts nothing new', async () => {
    const restateIngress = fakeRestate();
    const app = core();
    const { taskId, chat } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    const first = await (await deliver(app, taskId)).json();
    const second = await deliver(app, taskId);
    expect(second.status).toBe(202);
    const body = await second.json();
    expect(body).toMatchObject({ executor: 'restate', deliveryId: first.deliveryId, alreadyDelivering: true });
    // Asked for again under the same key (a start whose answer was lost is made good), and Restate said 409.
    expect(restateIngress.starts.map((s) => s.deliveryId)).toEqual([first.deliveryId, first.deliveryId]);
    expect((await publications(taskId)).map((p) => [p.executor_run, p.executor_finished_run])).toEqual([[1, 0]]);
  });

  it('a Core restart while the workflow runs leaves the delivery to it, even once the chat is off the list', async () => {
    const restateIngress = fakeRestate();
    const before = core();
    const { taskId, chat } = await approvedTask(before, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    const first = await (await deliver(before, taskId)).json();
    delete process.env.HAWA_LIFECYCLE_CHATS;
    const publisher = archivingPublisher();
    const after = core(publisher);
    const res = await deliver(after, taskId);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ executor: 'restate', deliveryId: first.deliveryId, alreadyDelivering: true });
    // reopenInterruptedDelivery did not take it back to approved, and Core's own delivery did not run.
    expect(await taskState(taskId)).toBe('publishing');
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(restateIngress.starts).toHaveLength(2);
  });

  it('Drive refused: the files still reach the requester once, the task goes back to approved, and a later run sends nothing twice', async () => {
    const restateIngress = fakeRestate();
    const telegram = fakeTelegram();
    const app = core(noDrivePublisher());
    const { taskId, chat } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    await deliver(app, taskId);
    const outcome = await worker(app, telegram)(restateIngress.starts[0]);
    expect(outcome).toMatchObject({ outcome: 'chat_only', archived: false, filesSent: 2 });
    expect(telegram.received.filter((r) => r.chatId === chat).map((r) => r.kind)).toEqual(['document', 'document', 'text']);
    expect(telegram.received.find((r) => r.kind === 'text')!.text).toContain('Office archive: not saved to Google Drive yet');
    expect(await taskState(taskId)).toBe('approved');
    expect((await publications(taskId)).map((p) => [p.executor, p.executor_run, p.executor_finished_run])).toEqual([['restate', 1, 1]]);

    // Core's own delivery refuses a publication the workflow owns (publish-omnichannel reaches it directly).
    const direct = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers, body: JSON.stringify({}) });
    expect(direct.status).toBe(409);
    expect((await direct.json()).detail).toMatch(/Delivery workflow/);

    // Deliver again once Drive works: run 2 retries the archive, and the requester gets nothing twice.
    const fixed = core(archivingPublisher());
    const res = await (await deliver(fixed, taskId)).json();
    expect(res.deliveryId).toMatch(/:archive:2$/);
    const second = await worker(fixed, telegram)(restateIngress.starts[1]);
    expect(second).toMatchObject({ outcome: 'delivered', archived: true, filesSent: 2 });
    expect(telegram.received.filter((r) => r.chatId === chat)).toHaveLength(3);
    expect(await taskState(taskId)).toBe('complete');
  });

  it('a file Telegram may not have taken: sent once, the office alerted once, and completion waits for resolution', async () => {
    const restateIngress = fakeRestate();
    const telegram = fakeTelegram((chatId, kind, filename) => (kind === 'document' && filename?.endsWith('.pptx') ? { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' } : { success: true }));
    const app = core();
    const { taskId, chat } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    await deliver(app, taskId);
    const run = worker(app, telegram);
    const outcome = await run(restateIngress.starts[0]);
    expect(outcome).toMatchObject({ outcome: 'uncertain', filesSent: 1 });
    await run(restateIngress.starts[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(telegram.received.filter((r) => r.chatId === chat && r.kind === 'document')).toHaveLength(2);
    const alerts = telegram.received.filter((r) => r.chatId === OFFICE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain(taskId);
    expect(await taskState(taskId)).toBe('publishing');
    const publicationState = await (await app.request(`/tasks/${taskId}/publication-state`, { headers })).json();
    expect(publicationState).toMatchObject({ state: 'requester_send_reconciliation' });
    expect(publicationState.actionableRecovery).toContain('inspect the Telegram chat');
    const retry = await deliver(app, taskId);
    expect(retry.status).toBe(409);
    expect((await retry.json()).detail).toContain('previous Telegram send');
    expect(restateIngress.starts).toHaveLength(1);
    const stored = await withRlsContext(db, operator, async (trx) => {
      const pub = await new PublicationRepository(db).findByTaskId(taskId, tenantId, trx);
      return pub ? (await new PublicationRepository(db).getPublicationWithRefs(pub.id, tenantId, trx)) : null;
    });
    const file = stored?.driveRefs[0];
    expect(file?.status).toBe('verified');
    await expect(withRlsContext(db, operator, (trx) => new PublicationRepository(db).recordDriveRef({
      tenantId, publicationId: String(stored?.publication.id), fileId: String(file?.file_id),
      sharedDriveId: String(file?.shared_drive_id), folderId: String(file?.folder_id),
      fileName: String(file?.file_name), mimeType: String(file?.mime_type),
      expectedSha256: 'f'.repeat(64), observedSize: Number(file?.observed_size), status: 'verified',
    }, trx))).rejects.toThrow(/conflicts with its stored publication receipt/);
  });

  it('a refused Telegram file cannot complete an archived publication with a confirmed Sheet row', async () => {
    const restateIngress = fakeRestate();
    const telegram = fakeTelegram((_chatId, kind, filename) =>
      kind === 'document' && filename?.endsWith('.pptx') ? { success: false, error: 'TELEGRAM_DOCUMENT_REJECTED_403' } : { success: true });
    const app = core();
    const { taskId, chat } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    await deliver(app, taskId);
    const outcome = await worker(app, telegram)(restateIngress.starts[0]);
    expect(outcome).toMatchObject({ outcome: 'failed', archived: true, sheetsConfirmed: true, filesSent: 1 });
    expect(await taskState(taskId)).toBe('publishing');
    expect((await publications(taskId)).map((p) => [p.state, p.executor_finished_run])).toEqual([['drive_complete', 1]]);
    const publicationState = await (await app.request(`/tasks/${taskId}/publication-state`, { headers })).json();
    expect(publicationState).toMatchObject({ state: 'requester_send_reconciliation' });
    const retry = await deliver(app, taskId);
    expect(retry.status).toBe(409);
    expect(restateIngress.starts).toHaveLength(1);
  });

  it('a run whose report never reached Core is recorded from its output on the next press', async () => {
    const restateIngress = fakeRestate();
    const telegram = fakeTelegram();
    const app = core();
    const { taskId, chat } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    await deliver(app, taskId);
    // The report step gave up (Core away for the hour it waits): the worker's client ends it as terminal.
    const coreGoneForTheReport = coreInternalFromEnv(((input: any, init: any) => String(input).endsWith('/delivery-finished')
      ? Promise.resolve(new Response(JSON.stringify({ code: 'GONE' }), { status: 410 }))
      : app.request(String(input), init)) as typeof fetch);
    const input = restateIngress.starts[0];
    const outcome = await worker(app, telegram, { core: coreGoneForTheReport })(input);
    restateIngress.outputs.set(input.deliveryId, outcome);
    expect(await taskState(taskId)).toBe('publishing');

    const res = await deliver(app, taskId);
    expect(await res.json()).toMatchObject({ deliveryId: input.deliveryId, recordedOutcome: 'delivered', status: 'DELIVERY_RECORDED' });
    expect(await taskState(taskId)).toBe('complete');
    expect((await publications(taskId)).map((p) => [p.state, p.executor_finished_run])).toEqual([['complete', 1]]);
  });

  it('a delivery Core\'s own path started stays Core\'s once the chat is flagged', async () => {
    const restateIngress = fakeRestate();
    const app = core(noDrivePublisher());
    const { taskId, chat } = await approvedTask(app);
    const first = await deliver(app, taskId);
    expect((await first.json()).status).toBe('DELIVERED_TO_CHAT_ONLY');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    const again = await deliver(app, taskId);
    expect(again.status).toBe(503);
    expect((await again.json()).detail).toMatch(/archive may already exist/i);
    expect(restateIngress.starts).toEqual([]);
    expect((await publications(taskId)).map((p) => p.executor)).toEqual(['core']);
  });

  it('the outbox dead-letters a notify.published for a publication the workflow owns, sending nothing', async () => {
    const restateIngress = fakeRestate();
    const telegram = fakeTelegram();
    const app = core();
    const { taskId, chat } = await approvedTask(app, 'restate');
    process.env.HAWA_LIFECYCLE_CHATS = chat;
    await deliver(app, taskId);
    const input = restateIngress.starts[0];
    // An older Core (or a hand) wrote one anyway.
    const repo = new OutboxRepository(db);
    const idempotencyKey = `guard-${randomUUID()}`;
    await withRlsContext(db, operator, (trx) => repo.enqueue({
      tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'notify.published', idempotencyKey,
      payload: { taskId, chatId: chat, title: 'x', publicationKey: `pub_key_${taskId}_${input.approvalId}`, files: [], driveFolderId: '', spreadsheetId: '', sheetsConfirmed: true },
    }, trx));
    const consumer = new OutboxConsumer(db, {
      tenantId, userId: operator.userId, batchSize: 100, telegramBotToken: ['bot', 'token'].join('_'), officeAlertChatId: OFFICE,
      telegramSender: () => telegram.bridge, readExportBytes: readStoredExportBytes,
    });
    await consumer.processBatch(100);
    const command = (await publishedCommands(taskId))[0];
    expect(command.state).toBe('failed');
    expect(command.last_error).toContain('DELIVERY_OWNED_BY_WORKFLOW');
    // Other tests' commands in this database were delivered as usual; this chat and the office got nothing.
    expect(telegram.received.filter((r) => r.chatId === chat || r.chatId === OFFICE)).toEqual([]);
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
        const finished = await app.request(`/v1/internal/tasks/${taskId}/delivery-finished`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: '{}',
        });
        expect(finished.status).toBe(401);
      }
      // With the worker's token: a task that is not there (or not in the tenant) is not found.
      expect((await prepare(app, taskId, approvalId, `Bearer ${workerToken}`)).status).toBe(404);
    });

    it('refuse to prepare a task that is not being delivered by the workflow', async () => {
      const app = core();
      const { taskId } = await approvedTask(app);
      const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
      const res = await prepare(app, taskId, detail.latestApproval?.decisionId || randomUUID(), `Bearer ${workerToken}`);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('NOT_PUBLISHING');
    });

    it('holds a credential failure when a prior workflow upload has a durable reservation', async () => {
      const restateIngress = fakeRestate();
      const app = core(noDrivePublisher());
      const { taskId, chat } = await approvedTask(app, 'restate');
      process.env.HAWA_LIFECYCLE_CHATS = chat;
      expect((await deliver(app, taskId)).status).toBe(202);
      const input = restateIngress.starts[0];
      await withRlsContext(db, operator, async (trx) => {
        const publication = (await sql<{ id: string; package_sha256: string }>`SELECT id, package_sha256
          FROM hawa.publications WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid`.execute(trx)).rows[0];
        await sql`INSERT INTO hawa.drive_upload_reservations
          (tenant_id, publication_id, artifact_id, task_id, package_sha256, folder_id, file_name, mime_type, expected_sha256, drive_file_id)
          VALUES (${tenantId}::uuid, ${publication.id}::uuid, ${randomUUID()}::uuid, ${taskId}::uuid,
            ${publication.package_sha256}, 'kaae-folder', 'approved.png', 'image/png', ${'a'.repeat(64)}, ${`reserved_${randomUUID()}`})`.execute(trx);
      });

      const result = await prepare(app, taskId, input.approvalId, `Bearer ${workerToken}`);
      expect(result.status).toBe(503);
      expect(await result.json()).toMatchObject({ code: 'ARCHIVE_STATE_UNCERTAIN' });
      expect(await taskState(taskId)).toBe('publishing');
      expect(await publishedCommands(taskId)).toEqual([]);
      expect((await (await app.request(`/tasks/${taskId}`, { headers })).json()).status).toBe('ARCHIVE_RECONCILIATION');
      const state = await (await app.request(`/tasks/${taskId}/publication-state`, { headers })).json();
      expect(state).toMatchObject({ status: 'ARCHIVE_RECONCILIATION', state: 'archive_reconciliation' });

      // A terminal prepare report must not turn a possible stored Drive file into "no archive".
      const finished = await app.request(`/v1/internal/tasks/${taskId}/delivery-finished`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
        body: JSON.stringify({ tenantId, deliveryId: input.deliveryId, approvalId: input.approvalId, run: 1,
          outcome: { outcome: 'failed', uncertain: [], sheetsConfirmed: false, archived: false,
            filesSent: 0, reason: 'PREPARE_FAILED: DRIVE_IDENTITY_CONFLICT' } }),
      });
      expect(await finished.json()).toMatchObject({ status: 'applied', taskState: 'publishing' });
      expect((await (await app.request(`/tasks/${taskId}`, { headers })).json()).status).toBe('ARCHIVE_RECONCILIATION');
      expect(await publishedCommands(taskId)).toEqual([]);
    });

    it('record a report once: a second report of the same run changes nothing', async () => {
      const restateIngress = fakeRestate();
      const app = core();
      const { taskId, chat } = await approvedTask(app, 'restate');
      process.env.HAWA_LIFECYCLE_CHATS = chat;
      await deliver(app, taskId);
      const input = restateIngress.starts[0];
      const report = (outcome: DeliveryOutcome) => app.request(`/v1/internal/tasks/${taskId}/delivery-finished`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
        body: JSON.stringify({ tenantId, deliveryId: input.deliveryId, approvalId: input.approvalId, run: 1, outcome }),
      });
      const failed: DeliveryOutcome = { outcome: 'failed', uncertain: [], sheetsConfirmed: false, archived: false, filesSent: 0, reason: 'PREPARE_FAILED' };
      expect(await (await report(failed)).json()).toEqual({ status: 'applied', taskState: 'approved' });
      expect(await (await report({ ...failed, outcome: 'delivered', archived: true, sheetsConfirmed: true })).json()).toEqual({ status: 'replayed', taskState: 'approved' });
      expect(await taskState(taskId)).toBe('approved');
      // A run that was never started is refused.
      const unknown = await app.request(`/v1/internal/tasks/${taskId}/delivery-finished`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
        body: JSON.stringify({ tenantId, deliveryId: `${input.deliveryId}:archive:5`, approvalId: input.approvalId, run: 5, outcome: failed }),
      });
      expect(unknown.status).toBe(409);
    });
  });
});
