import {runReceiptAudit} from './fixtures/run-receipt-audit.js';
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { computeActionSignature, signActionLink } from '@hawa/integrations';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import {persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { createHash } from 'node:crypto';

describe('Core API: Ingress & Task Lifecycle', () => {
  const exports = memoryExportStore();
  const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store });
  // Revisions, decisions and deliveries are only held in Postgres (architecture programme 1.3, groups
  // G3 and G5): the tests that reach them use this app, on this file's own test database.
  const testDb = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => testDb.destroy());
  const dbApp = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store });
  /** KAAE's seeded client row; Postgres takes only a uuid client id. */
  const KAAE = 'c1000000-0000-4000-8000-000000000002';
  /** A seeded client the legacy generator still drafts (KAAE's designs are made in the studio). */
  const HAWA_STUDIO = 'c1000000-0000-4000-8000-000000000001';
  const DRUSTEE = 'c1000000-0000-4000-8000-000000000003';
  beforeAll(async()=>{
    await persistClientDnaFixture(dbApp,HAWA_STUDIO,{},undefined,'client-office-1');
    await persistClientDnaFixture(dbApp,DRUSTEE,{});
  });

  it('responds to health checks', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('healthy');
  });

  it('does not call an unrun paid model probe connected', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'configured-but-unverified-test-key';
    try {
      const res = await app.request('/health');
      const json = await res.json();
      // This app schedules no paid probe: "disabled", never "connected" (ADR-158; "unverified" is
      // for a scheduled probe that has not answered yet, health-semantics.test.ts).
      expect(json.dependencies.modelProvider).toBe('disabled');
      expect(json.lastPaidProbe.status).toBe('disabled');
      expect(json.lastPaidProbe.at).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  // The Telegram webhook (POST /webhooks/telegram) was removed by stage 2 of ADR-135: the worker polls
  // and hands each update to POST /v1/internal/telegram/intake. Its answers to briefs, /status,
  // duplicates, passive and group messages are lifecycle-internal-intake.test.ts's.
  it('has no Telegram webhook left', async () => {
    for (const path of ['/api/webhooks/telegram', '/v1/webhooks/telegram', '/webhooks/telegram']) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'expected_office_secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 101, message: { text: 'New poster request', chat: { id: 777 } } }),
      });
      expect(res.status, path).toBe(404);
    }
  });

  it('routes a Sorani KAAE brief to KAAE in the draft a new Telegram request opens', async () => {
    // What the lifecycle's open-request builds (lifecycle-internal.routes.ts).
    const text = 'دەستپێکردنی خولی باوەڕپێدانی زانکۆکانی کەی ئەی ئەی ئی ٢٠٢٦';
    const draft = await createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
      platform: 'telegram', sourceEventId: 'core-kaae-routing-1011', sourceChannelId: '9988',
      senderName: 'Hawzhin', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
    });
    expect(draft.clientId).toBe(KAAE);
  });

  it('exposes telegram adapter health and configuration via /v1/adapters/telegram/status', async () => {
    const res = await app.request('/v1/adapters/telegram/status');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.botConfigured).toBe(Boolean(process.env.TELEGRAM_BOT_TOKEN));
    // Core never asked Telegram which bot the token belongs to, so it names none.
    expect(json.botUsername).toBeUndefined();
    expect(json.botName).toBeUndefined();
    expect(json.bridge).toBeDefined();
  });

  it('creates task via Desk API with Idempotency-Key', async () => {
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'desk-key-123',
      },
      body: JSON.stringify({
        title: 'Spring Campaign Poster',
        description: 'Design promo poster for Instagram',
      }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.idempotencyKey).toBe('desk-key-123');

    // Replay returns same task
    const resReplay = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'desk-key-123',
      },
      body: JSON.stringify({
        title: 'Spring Campaign Poster',
      }),
    });
    expect(resReplay.status).toBe(200);
    const replayTask = await resReplay.json();
    expect(replayTask.id).toBe(task.id);
  });

  it('executes task progression: route -> brief -> generate -> real QA -> approval refused while QA fails', async () => {
    // 1. Create task
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Year Campaign' }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();
    const taskId = task.id;

    // 2. Route task (lock client scope)
    const routeRes = await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-nova', reason: 'Client assigned' }),
    });
    expect(routeRes.status).toBe(202);
    const routeReceipt = await routeRes.json();
    expect(routeReceipt.commandId).toBeDefined();

    // 3. Create brief
    const briefRes = await app.request(`/v1/tasks/${taskId}/briefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'New Year Promo',
        rawRequestText: 'داشکاندنی ٢٥٪ تا ١٠ی مانگ',
        primaryLanguage: 'ckb',
        direction: 'rtl',
      }),
    });
    expect(briefRes.status).toBe(201);
    const brief = await briefRes.json();
    expect(brief.direction).toBe('rtl');
    expect(brief.exactCopy[0].protectedTokens.length).toBeGreaterThan(0);

    // 4. Generate design
    const genRes = await app.request(`/v1/tasks/${taskId}/generate`, {
      method: 'POST',
    });
    expect(genRes.status).toBe(202);

    // Check task state is AWAITING_APPROVAL
    const taskCheck = await app.request(`/v1/tasks/${taskId}`);
    const currentTask = await taskCheck.json();
    expect(currentTask.status).toBe('AWAITING_APPROVAL');
    expect(currentTask.latestRevisionId).toBeDefined();

    // 4b. Test Studio Deep-Link URL generation (FR-029)
    const editorUrlRes = await app.request(`/v1/tasks/${taskId}/editor-url`);
    expect(editorUrlRes.status).toBe(200);
    const editorUrlData = await editorUrlRes.json();
    expect(editorUrlData.url).toMatch(/figma\.com\/design|\/review\?doc=|canva\.com\/design/);
    expect(editorUrlData.taskId).toBe(taskId);

    // 4c. The legacy export package is retired (ADR-025): it listed files that were never made.
    const pkgRes = await app.request(`/v1/tasks/${taskId}/export-package`);
    expect(pkgRes.status).toBe(410);

    // 5. QA really ran on the generated design. The generic generator draws a placeholder logo hash,
    //    so the official client logo is missing and QA fails (it used to be a literal all-pass report).
    expect(currentTask.latestQAReport.criticalPass).toBe(false);
    expect(currentTask.latestQAReport.findings.map((f: any) => f.ruleId)).toContain('OFFICIAL_LOGO_MISSING_OR_MUTATED');

    // 6. A design failing critical QA cannot be approved. This app has no database, and an approval is
    //    recorded only in Postgres, so it is refused before QA is weighed; the refusal for failing QA
    //    itself is shown on a database in generate-real-qa.test.ts and r05-immutable-approval-contract.test.ts.
    const approveRes = await app.request(`/v1/tasks/${taskId}/revisions/${currentTask.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director_1',
        pinnedExportIds: [exports.add(taskId)],
      }),
    });
    expect(approveRes.status).toBe(503);
    expect((await approveRes.json()).detail).toBe('A review decision is only recorded in the database');
    expect((await (await app.request(`/v1/tasks/${taskId}`)).json()).status).toBe('AWAITING_APPROVAL');

    // 7. Check timeline
    const timelineRes = await app.request(`/v1/tasks/${taskId}/timeline`);
    const timeline = await timelineRes.json();
    expect(timeline.events.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces repair budget of max 2 cycles on revision requests', async () => {
    const app = dbApp;
    // A client the legacy generator still drafts: KAAE's designs are made only in the studio (ADR-127).
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Revision Test', headlineEn: 'Revision Test' }),
    });
    const { id: taskId } = await createRes.json();

    // Route and Generate
    await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: HAWA_STUDIO }),
    });
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });

    const revCheck = await app.request(`/v1/tasks/${taskId}`);
    let { latestRevisionId } = await revCheck.json();

    // Revision 1
    const rev1 = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Fix colors' } }),
    });
    expect(rev1.status).toBe(201);
    let taskState = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(taskState.status).toBe('REVISION_REQUESTED');

    // Transition back to AWAITING_APPROVAL
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });
    const nextRevision = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(nextRevision.status).toBe('AWAITING_APPROVAL');
    expect(nextRevision.latestRevisionId).not.toBe(latestRevisionId);
    const stale = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Stale request must not count' } }),
    });
    expect(stale.status).toBe(409);
    latestRevisionId = nextRevision.latestRevisionId;

    // Revision 2
    const rev2 = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Fix alignment' } }),
    });
    expect(rev2.status).toBe(201);
    taskState = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(taskState.status).toBe('REVISION_REQUESTED');

    // Transition back to AWAITING_APPROVAL
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });
    const finalRevision = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(finalRevision.status).toBe('AWAITING_APPROVAL');
    expect(finalRevision.latestRevisionId).not.toBe(latestRevisionId);
    latestRevisionId = finalRevision.latestRevisionId;

    // Revision 3 (exceeds budget -> OPERATOR_REQUIRED)
    const rev3 = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Still bad' } }),
    });
    expect(rev3.status).toBe(201);
    taskState = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(taskState.status).toBe('OPERATOR_REQUIRED');
  });

  it('provides client DNA, integrations health, and evaluations API', async () => {
    // Client DNA
    const dnaRes = await app.request('/v1/clients/client-office-1/dna');
    expect(dnaRes.status).toBe(200);
    const dna = await dnaRes.json();
    expect(dna.name).toBe('Hawa Creative');

    // Integrations Health
    const healthRes = await app.request('/v1/integrations/health');
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.items.length).toBe(7);
    for (const item of health.items) {
      expect(item.state).not.toBe('healthy');
      expect(item.reachability).toBe('unknown');
      expect(item.paidVerification).toBe('not_run');
      expect(item.lastVerifiedAt).toBeNull();
      expect(item.nextAction).toBeTruthy();
    }

    // Operations Failures are the failed tasks Postgres holds
    const failRes = await dbApp.request('/v1/operations/failures');
    expect(failRes.status).toBe(200);
    expect((await app.request('/v1/operations/failures')).status).toBe(503);
  });

  it('reports a configured Drive adapter without claiming it is reachable or paid-verified', async () => {
    const previous = process.env.GOOGLE_DRIVE_FOLDER_ID;
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'fixture-folder';
    try {
      const response = await app.request('/v1/integrations/health');
      expect(response.status).toBe(200);
      const body = await response.json();
      const drive = body.items.find((item: any) => item.integrationId === 'int_google_drive');
      expect(drive).toMatchObject({
        configured: true,
        state: 'configured',
        reachability: 'unknown',
        paidVerification: 'not_run',
        lastVerifiedAt: null,
      });
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
      else process.env.GOOGLE_DRIVE_FOLDER_ID = previous;
    }
  });

  it('reads the Phoenix collector under the name production uses as well as the old one (ADR-159)', async () => {
    const phoenix = async () => (await (await app.request('/v1/integrations/health')).json()).items
      .find((item: any) => item.integrationId === 'int_phoenix');
    vi.stubEnv('PHOENIX_COLLECTOR_URL', '');
    vi.stubEnv('PHOENIX_COLLECTOR_ENDPOINT', '');
    try {
      expect(await phoenix()).toMatchObject({ configured: false });
      vi.stubEnv('PHOENIX_COLLECTOR_ENDPOINT', 'http://phoenix:6006/v1/traces');
      expect(await phoenix()).toMatchObject({ configured: true, reachability: 'unknown' });
      vi.stubEnv('PHOENIX_COLLECTOR_ENDPOINT', '');
      vi.stubEnv('PHOENIX_COLLECTOR_URL', 'http://phoenix:6006');
      expect(await phoenix()).toMatchObject({ configured: true });
    } finally { vi.unstubAllEnvs(); }
  });

  it('streams real-time Server-Sent Events (SSE) and broadcasts task mutations', async () => {
    // Resource disclosure needs the current persisted row under RLS (ADR223).
    const streamRes = await dbApp.request('/v1/events/stream');
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    const reader = streamRes.body?.getReader();
    expect(reader).toBeDefined();

    // 1. Initial Handshake chunk
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    const firstText = new TextDecoder().decode(firstChunk.value);
    expect(firstText).toContain('event: system:connected');
    expect(firstText).toContain('"status":"connected"');

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // 2. Trigger a persisted task while the stream is actively listening.
      const postRes = await dbApp.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `sse-stream-test-${Date.now()}`,
        },
        body: JSON.stringify({
          title: 'SSE Stream Verification Task',
          priority: 'routine',
          clientId: HAWA_STUDIO,
        }),
      });

      expect(postRes.status).toBe(201);
      const task = await postRes.json();
      const mutation = (async () => {
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
          const part = await reader!.read();
          if (part.done) throw new Error('Stream closed before its persisted task event');
          pending += decoder.decode(part.value, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            if (!frame.includes('event: task:created\n')) continue;
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (!data) throw new Error('Task event has no data');
            const payload = JSON.parse(data.slice(6));
            if (payload.id === task.id) return payload;
          }
        }
      })();
      const payload = await Promise.race([mutation, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Persisted task event was not delivered')), 3000);
      })]);
      expect(payload).toMatchObject({ id: task.id, title: 'SSE Stream Verification Task', clientId: HAWA_STUDIO });
    } finally {
      if (timeout) clearTimeout(timeout);
      await reader!.cancel();
    }
  });

  it('reports office availability as unmeasured and refuses synthetic operational execution', async () => {
    const getRes = await app.request('/v1/operations/slo');
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({evidenceKind:'unmeasured',availability:{observedPercent:null,sloCompliant:null},latency:{p99Ms:null}});
    expect((await app.request('/v1/operations/slo/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(410);
  });

  it('GET /v1/operations/reconciliation & POST /v1/operations/reconciliation/run audit drift and refuse auto-repair (FR-049, FR-050)', async () => {
    // The audit compares the tasks and delivery records Postgres holds; without a database there is none.
    expect((await app.request('/v1/operations/reconciliation/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(503);
    // 1. Before any audit there is no report, not an invented clean one
    const getRes = await dbApp.request('/v1/operations/reconciliation');
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).latest).toBeNull();

    // 2. Auto-repair is refused: Core cannot upload to Drive or write Sheets from here
    const repairRes = await dbApp.request('/v1/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoRepair: true }),
    });
    expect(repairRes.status).toBe(422);
    expect((await repairRes.json()).title).toBe('Auto-Repair Not Available');

    // 3. The audit runs and says what it compared
    const runRes = await runReceiptAudit(dbApp);
    expect(runRes.status).toBe(201);
    const runReport = await runRes.json();
    expect(runReport.auditId).toBeDefined();
    expect(['clean', 'divergent']).toContain(runReport.status);
    expect(runReport.simulated).toBe(false);
    expect(runReport.basis).toContain('Google Drive and Google Sheets were not read');
    expect(runReport).not.toHaveProperty('repairedCount');
    expect(runReport.totalTasksAudited).toBeGreaterThanOrEqual(1);

    const latest = await (await dbApp.request('/v1/operations/reconciliation')).json();
    expect(latest.latest.auditId).toBe(runReport.auditId);
  });

  it('GET /v1/clients lists seeded client tenants with color & rule metrics', async () => {
    const res = await app.request('/v1/clients');
    expect(res.status).toBe(200);
    const clients = await res.json();
    expect(clients.length).toBeGreaterThanOrEqual(4);

    const aster = clients.find((c: any) => c.clientId === 'client-aster');
    expect(aster).toBeDefined();
    expect(aster.name).toBe('Aster Hotel & Resort');
    expect(aster.code).toBe('ASTER');
    expect(aster.version).toBe(12);
    expect(aster.colorsCount).toBe(3);
    expect(aster.rulesCount).toBe(3);
    expect(aster.snapshotsCount).toBeGreaterThanOrEqual(2);
  });

  it('GET /v1/clients/:clientId/snapshots & POST /v1/clients/:clientId/snapshots governs immutable audit log', async () => {
    // 1. Fetch initial snapshots for Aster Hotel
    const getRes = await app.request('/v1/clients/client-aster/snapshots');
    expect(getRes.status).toBe(200);
    const snapshots = await getRes.json();
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].version).toBe(12);
    expect(snapshots[0].sha256).toMatch(/^sha256_[0-9a-f]+/);
    expect(snapshots[0].createdBy).toBe('art_director');

    // 2. Commit a new immutable governance snapshot
    const postRes = await app.request('/v1/clients/client-aster/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commitMessage: 'Certified Nawroz 2026 luxury gold palette and Kurdish typography invariants',
        createdBy: 'creative_director',
      }),
    });
    expect(postRes.status).toBe(201);
    const newSnap = await postRes.json();
    expect(newSnap.version).toBe(13);
    expect(newSnap.sha256).toMatch(/^sha256_[0-9a-f]+/);
    expect(newSnap.commitMessage).toContain('Nawroz 2026');
    expect(newSnap.createdBy).toBe('creative_director');

    // 3. Verify snapshot is in history list
    const updatedGetRes = await app.request('/v1/clients/client-aster/snapshots');
    const updatedList = await updatedGetRes.json();
    expect(updatedList.length).toBe(3);
    expect(updatedList[0].version).toBe(13);
    expect(updatedList[0].snapshotId).toBe(newSnap.snapshotId);
  });

  it('executes the Drustee lifecycle up to review (Ingress ➔ Route ➔ Brief ➔ Generate ➔ real QA), and refuses approval while QA fails', async () => {
    // 1. Task Ingress (Desk simulator or internal user)
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
      },
      body: JSON.stringify({
        title: 'Active Vitamin D3 + K2 Launch Drops',
        clientId: 'client-drustee',
        headlineEn: 'Pure Vitamin D3 + K2 Drops',
        headlineCkb: 'ڤیتامین D3 + K2 ی زانستی',
        copyEn: '5000 IU / 100mcg · Third-Party Lab Tested · GMP Certified',
        copyCkb: '٥٠٠٠ یەکەی نێودەوڵەتی · پشکنراوی تاقیگەیی باوەڕپێکراو',
        priority: 'high',
      }),
    });
    expect(createRes.status).toBe(201);
    const createdTask = await createRes.json();
    expect(createdTask.id).toBeDefined();
    expect(createdTask.status).toBe('RECEIVED');
    expect(createdTask.clientId).toBe('client-drustee');
    expect(createdTask.headlineEn).toBe('Pure Vitamin D3 + K2 Drops');
    expect(createdTask.clientScopeLocked).toBe(false);

    const taskId = createdTask.id;

    // 2. Route Task (Locks Client Scope, Invariant #5)
    const routeRes = await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-drustee', reason: 'Confirmed Drustee Clinical Tenant' }),
    });
    expect(routeRes.status).toBe(202);

    const routedTaskRes = await app.request(`/v1/tasks/${taskId}`);
    const routedTask = await routedTaskRes.json();
    expect(routedTask.status).toBe('BRIEFING');
    expect(routedTask.clientScopeLocked).toBe(true);

    // 3. Create Brief
    const briefRes = await app.request(`/v1/tasks/${taskId}/briefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Active Vitamin D3+K2 Drops Social Launch',
        rawRequestText: 'Drustee Vitamin D3 + K2 5000 IU',
        copyBlocks: [
          { role: 'headline', text: 'ڤیتامین D3 + K2 ی زانستی' },
          { role: 'copy', text: '٥٠٠٠ یەکەی نێودەوڵەتی · کوالێتی باوەڕپێکراو' },
        ],
      }),
    });
    expect(briefRes.status).toBe(201);

    // 4. Generate Studio Revision
    const genRes = await app.request(`/v1/tasks/${taskId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Clinical amber dropper on emerald studio backdrop' }),
    });
    expect(genRes.status).toBe(202);

    const taskCheck = await app.request(`/v1/tasks/${taskId}`);
    const generatedTask = await taskCheck.json();
    expect(generatedTask.status).toBe('AWAITING_APPROVAL');
    expect(generatedTask.latestRevisionId).toBeDefined();

    const revisionId = generatedTask.latestRevisionId;

    // 5. QA really ran. The Drustee template adds text outside the approved copy and does not place the
    //    DNA's official logo, so QA fails with those findings.
    const qaRuleIds = generatedTask.latestQAReport.findings.map((f: any) => f.ruleId);
    expect(generatedTask.latestQAReport.criticalPass).toBe(false);
    expect(qaRuleIds).toEqual(expect.arrayContaining(['UNSOLICITED_CONTENT_DETECTED', 'OFFICIAL_LOGO_MISSING_OR_MUTATED']));

    // 6. Approval is refused while critical QA fails. Without a database it is refused before QA is
    //    weighed (an approval is recorded only in Postgres); see test 1 of this file.
    const decisionRes = await app.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director',
        pinnedExportIds: [exports.add(taskId)],
      }),
    });
    expect(decisionRes.status).toBe(503);

    // Verify timeline has the audit trail so far
    const timelineRes = await app.request(`/v1/tasks/${taskId}/timeline`);
    const timeline = await timelineRes.json();
    expect(timeline.events.length).toBeGreaterThanOrEqual(4);
  });

  it('generates sandboxed ComfyUI visual backdrops and smart contrast composites (Invariant #4)', async () => {
    // 1. Generate clinical podium background for Drustee
    const bgRes = await app.request('/v1/ai/comfy-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'clinical_podium_mesh',
        aspectRatio: 'feed',
        prompt: 'Drustee Vitamin D3+K2 clean podium',
        primaryColor: '#0B192C',
        accentColor: '#FFB200',
        applySmartScrim: true,
      }),
    });

    expect(bgRes.status).toBe(201);
    const bgData = await bgRes.json();
    expect(bgData.status).toBe('VERIFIED_SANDBOXED');
    expect(bgData.templateId).toBe('clinical_podium_mesh');
    expect(bgData.aspectRatio).toBe('feed');
    expect(bgData.dimensions).toEqual({ width: 1080, height: 1350 });
    expect(bgData.scrimApplied).toBe(true);
    expect(bgData.guaranteedWcagLevel).toBe('AAA');
    expect(bgData.svgContent).toContain('<svg viewBox="0 0 1080 1350"');
    // Invariant #4: Backdrops must never embed rasterized text
    expect(bgData.svgContent).not.toContain('<text');
    expect(bgData.svgContent).not.toContain('<tspan');

    // 2. Test composite endpoint with smart contrast scrim
    const cmpRes = await app.request('/v1/ai/comfy-composite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'kurdish_geometric_luxury',
        aspectRatio: 'story',
        headlineColor: '#FFFFFF',
        backgroundColor: '#0A1C1F',
      }),
    });

    expect(cmpRes.status).toBe(200);
    const cmpData = await cmpRes.json();
    expect(cmpData.status).toBe('COMPOSITE_VERIFIED');
    expect(cmpData.aspectRatio).toBe('story');
    expect(cmpData.dimensions).toEqual({ width: 1080, height: 1920 });
    expect(cmpData.wcagContrast.level).toBe('AAA');
    expect(cmpData.wcagContrast.scrimEnforced).toBe(true);
    expect(cmpData.invariantCompliance.invariant2_live_vector_text).toBe('VERIFIED_UNFLATTENED');
    expect(cmpData.invariantCompliance.invariant4_reference_pixels_never_ship).toBe('VERIFIED_VECTOR_SANDBOX');
  });

  it('inspects WebFont coverage, retires fixture budgets, reviews owner instructions, and provides client-scoped omnisearch', async () => {
    // 1. Font Inspection Endpoint
    const fontRes = await app.request('/v1/fonts/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fontName: 'Noto Sans Arabic Kurdish' }),
    });
    expect(fontRes.status).toBe(200);
    const fontData = await fontRes.json();
    expect(fontData.status).toBe('AAA_COMPLIANT');
    expect(fontData.coveragePercentage).toBe(100);
    expect(fontData.hasZwnj).toBe(true);
    expect(fontData.diacriticClearanceRatio).toBe(1.52);

    // Legacy fixture budgets cannot represent office paid-call accounting (ADR-102).
    const budgetRes = await app.request('/v1/clients/client-drustee/budget');
    expect(budgetRes.status).toBe(410);
    expect((await budgetRes.json()).detail).toContain('/spending/policy');
    const allocRes = await app.request('/v1/clients/client-drustee/budget/allocate', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capUsd:15})
    });
    expect(allocRes.status).toBe(410);

    // 3. An explicit owner instruction needs no invented approved task. The stored
    // revision edit flow is exercised by approved-refinement-learning.test.ts.
    const mineRes=await app.request('/v1/clients/client-drustee/candidate-rules/propose',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        title:'Owner typography instruction',category:'typography',ruleText:'Use the declared Drustee palette for this campaign',
        rationale:'Explicit owner instruction for human review',
      }),
    });
    expect(mineRes.status).toBe(201);
    const mineData=await mineRes.json();
    expect(mineData.proposal.provenance.taskId).toBeUndefined();
    expect(mineData.proposal.examples.positiveExampleTaskIds).toEqual([]);

    const candRes = await app.request('/v1/clients/client-drustee/candidate-rules');
    expect(candRes.status).toBe(200);
    const candData = await candRes.json();
    expect(candData.candidateRules.length).toBeGreaterThan(0);

    const firstRuleId = candData.candidateRules[0].id;
    const promoteRes = await app.request(`/v1/clients/client-drustee/candidate-rules/${firstRuleId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'creative_director' }),
    });
    expect(promoteRes.status).toBe(200);
    const promoteData = await promoteRes.json();
    expect(promoteData.promoted).toBe(true);
    expect(promoteData.rule.status).toBe('PROMOTED');
    expect(promoteData.auditHash).toBeDefined();

    // 4. Omnisearch with Invariant #4 client scoping
    const globalSearchRes = await app.request('/v1/search?q=studio');
    expect(globalSearchRes.status).toBe(200);
    const globalSearch = await globalSearchRes.json();
    expect(globalSearch.results.length).toBeGreaterThan(0);

    // Scoped search for Drustee
    const scopedSearchRes = await app.request('/v1/search?q=drustee&clientId=client-drustee');
    expect(scopedSearchRes.status).toBe(200);
    const scopedSearch = await scopedSearchRes.json();
    expect(scopedSearch.scopeEnforced).toBe(true);
    expect(scopedSearch.clientId).toBe('client-drustee');
  });

  it('handles WAHA WhatsApp webhook ingress with idempotency and budget debiting', async () => {
    const wahaPayload = {
      event: 'message',
      payload: {
        id: `waha_test_${Date.now()}`,
        from: '9647501234567@c.us',
        pushname: 'Drustee Official',
        body: 'ئۆفەری نوێی دروستی بۆ ڤیتامین دی٣',
        timestamp: 1725577300,
      },
    };

    const res = await app.request('/api/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wahaPayload),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.task.sourcePlatform).toBe('whatsapp');
    expect(data.task.clientId).toBe('client-drustee');
    expect(['RECEIVED', 'BRIEF_REVIEW']).toContain(data.task.status);
    expect(data.task.kurdishText).toContain('ڤیتامین دی٣');
    expect(data.task.costReceipt).toBeDefined();

    // Verify deduplication
    const dupRes = await app.request('/api/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wahaPayload),
    });
    expect(dupRes.status).toBe(200);
    const dupData = await dupRes.json();
    expect(dupData.duplicate).toBe(true);
  });

  it('runs Inbound Ingress Rehearsal with real-time budget tracking', async () => {
    const res = await app.request('/v1/ingress/rehearsal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-aster',
        platform: 'whatsapp',
        text: 'شەوی تایبەتی هەینی لە هۆتێل ئاستێر',
        senderName: 'Aster Resort Erbil',
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.task.sourcePlatform).toBe('whatsapp');
    expect(data.task.clientId).toBe('client-aster');
    expect(data.costReceipt).toBeDefined();
    expect(data.budgetStatus.spentUsd).toBeGreaterThan(0);
  });

  it('packages Kurdish WebFont and serves @font-face via CDN endpoint', async () => {
    // 1. Package font
    const pkgRes = await app.request('/v1/fonts/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fontName: 'AsterKurdishTitle' }),
    });

    expect(pkgRes.status).toBe(200);
    const pkg = await pkgRes.json();
    expect(pkg.family).toBe('AsterKurdishTitle');
    expect(pkg.cssBundle).toContain('@font-face');
    expect(pkg.cdnSnippet).toContain('/v1/fonts/cdn/AsterKurdishTitle/style.css');

    // 2. Fetch CDN CSS
    const cssRes = await app.request('/v1/fonts/cdn/AsterKurdishTitle/style.css');
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('Content-Type')).toContain('text/css');
    expect(cssRes.headers.get('Cache-Control')).toContain('immutable');
    const cssText = await cssRes.text();
    expect(cssText).toContain("font-family: 'AsterKurdishTitle'");
    expect(cssText).toContain('ascent-override: 95%');

    // 3. No font file is kept, so none is served: the stylesheet's local() sources apply. It served
    //    the package's bytes until the next restart, and 64 zero bytes for any other family.
    const fontRes = await app.request('/v1/fonts/cdn/AsterKurdishTitle/font.woff2');
    expect(fontRes.status).toBe(404);
    expect(cssText).toContain("local('AsterKurdishTitle')");
  });

  it('dispatches outbound campaign review to WhatsApp and processes inbound approval callback action', async () => {
    // 1. Create a sample task
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Two-Way Review Test', clientId: 'client-drustee' }),
    });
    const { id: taskId } = await createRes.json();

    // 2. Dispatch outbound review
    const dispatchRes = await app.request(`/v1/campaigns/${taskId}/dispatch-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+9647509998877' }),
    });

    expect(dispatchRes.status).toBe(200);
    const dispatchBody = await dispatchRes.json();
    expect(dispatchBody.ok).toBe(true);
    expect(dispatchBody.dispatch.actions.length).toBe(2);
    const approveAction = dispatchBody.dispatch.actions[0];
    expect(approveAction.action).toBe('approve');

    // 3. Simulate inbound callback via action webhook
    const actionUrl = approveAction.callbackUrl.replace('http://localhost:3001', '');
    // Opening the link (a link preview does the same) only shows the confirmation (ADR-159).
    const opened = await app.request(actionUrl, { method: 'GET' });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('<form method="POST"');
    expect((await (await app.request(`/v1/tasks/${taskId}`)).json()).status).not.toBe('APPROVED');
    const callbackRes = await app.request('/api/webhooks/whatsapp/actions', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: actionUrl.split('?')[1] });
    expect(callbackRes.status).toBe(200);
    const htmlText = await callbackRes.text();
    expect(htmlText).toContain('کەمپینەکە بەسەرکەوتوویی پەسەندکرا');

    // 4. Verify task state is updated to APPROVED
    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('APPROVED');
  });

  it('refuses a review link whose publish flag, expiry or phone was changed, an expired one, and the old unsigned form (ADR-159)', async () => {
    const taskId = (await (await app.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Link tamper test', clientId: 'client-drustee' }) })).json()).id;
    const claims = { taskId, action: 'approve' as const, publish: false, exp: Math.floor(Date.now() / 1000) + 3600, phone: '+9647500000000' };
    const sig = signActionLink(claims);
    const post = (body: Record<string, unknown>) => app.request('/api/webhooks/whatsapp/actions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ ...claims, publish: true, sig })).status).toBe(403);
    expect((await post({ ...claims, exp: claims.exp + 86_400, sig })).status).toBe(403);
    expect((await post({ ...claims, phone: '+9647511111111', sig })).status).toBe(403);
    const old = { ...claims, exp: Math.floor(Date.now() / 1000) - 1 };
    expect((await post({ ...old, sig: signActionLink(old) })).status).toBe(410);
    expect((await post({ taskId, action: 'approve', sig: computeActionSignature(taskId, 'approve') })).status).toBe(400);
    const legacyGet = await app.request(`/api/webhooks/whatsapp/actions?taskId=${taskId}&action=approve&sig=${computeActionSignature(taskId, 'approve')}&publish=true`);
    expect(legacyGet.status).toBe(400);
    expect((await (await app.request(`/v1/tasks/${taskId}`)).json()).status).not.toBe('APPROVED');
  });

  it('publishes exactly the pinned export to the client\'s Google Drive and Sheets, with an emulated receipt', async () => {
    const app = dbApp;
    // 1. Create and approve task
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The Drustee template needs a headline and body; it refuses (COPY_REQUIRED) rather than drawing sample text.
      body: JSON.stringify({ title: 'Omnichannel Publishing Test', clientId: DRUSTEE, headlineEn: 'Omnichannel Publishing Test', copyEn: 'Vitamin D3 + K2, laboratory tested.' }),
    });
    const { id: taskId } = await createRes.json();

    // Transition to APPROVED
    await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: DRUSTEE }),
    });
    // A submitted revision (generated designs fail real QA until the generators are fixed).
    const revRes = await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'Omnichannel Publishing Test' }] } }),
    });
    const { revisionId: latestRevisionId } = await revRes.json();
    await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const pinnedBytes = new TextEncoder().encode('approved Drustee export');
    const exportId = exports.add(taskId, 'png', pinnedBytes);
    await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'approved', pinnedExportIds: [exportId] }),
    });

    // 2. Publish Omnichannel
    const pubRes = await app.request(`/v1/tasks/${taskId}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Omnichannel campaign release' }),
    });

    expect(pubRes.status).toBe(200);
    const pubData = await pubRes.json();
    expect(pubData.ok).toBe(true);
    expect(pubData.status).toBe('COMPLETE');
    // One file: the export the reviewer pinned, hashed from its own bytes (formerly 12 invented files).
    expect(pubData.filesCount).toBe(1);
    const receipt = pubData.publicationReceipt;
    expect(receipt.state).toBe('complete');
    expect(receipt.emulated).toBe(false);
    expect(receipt.driveFiles).toHaveLength(1);
    expect(receipt.driveFiles[0]).toMatchObject({
      artifactId: exportId,
      expectedSha256: createHash('sha256').update(pinnedBytes).digest('hex'),
      observedSize: pinnedBytes.length,
      verified: true,
    });
    expect(pubData).not.toHaveProperty('vaultUri');
    expect(pubData.driveFolderUrl).toContain('https://drive.google.com/drive/folders/');
    expect(pubData.sheetRowUrl).toContain('https://docs.google.com/spreadsheets/d/');
  });

  it('requires deployment and neither verifies browser secrets nor changes process or configuration', async () => {
    const realFetch=globalThis.fetch, calls: unknown[]=[];
    globalThis.fetch=(async (...args: unknown[])=>{calls.push(args);throw new Error('Must not contact caller endpoint');}) as typeof fetch;
    const saved=process.env.OPENAI_API_KEY;
    try {
      const res=await app.request('/v1/system/providers',{method:'POST',headers:{Authorization:'Bearer test_admin_key','Content-Type':'application/json'},
        body:JSON.stringify({openaiApiKey:'mock-never-written-key',wahaEndpoint:'http://169.254.169.254/latest/meta-data/'})});
      expect(res.status).toBe(409);expect(await res.json()).toMatchObject({title:'PROVIDER_DEPLOYMENT_REQUIRED'});
      expect(calls).toEqual([]);expect(process.env.OPENAI_API_KEY).toBe(saved);
    }finally{globalThis.fetch=realFetch;}
  });

  it('manages system provider credentials via /v1/system/providers', async () => {
    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.HAWA_ADMIN_KEY || 'test_admin_key'}`,
    };

    // 1. Query current providers status. With no key set, nothing is reported as configured:
    // no Google ADC claim, no account, and no fallback engine standing in for a missing key.
    const savedKeys = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const getRes = await app.request('/v1/system/providers', {
      headers: adminHeaders,
    });
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.ok).toBe(true);
    for (const [key, envVar] of [['gemini', 'GEMINI_API_KEY'], ['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']]) {
      expect(getData.providers[key]).toMatchObject({ envVar, configured: false, mode: 'Not configured', preview: 'Not configured', status: 'NOT_CONFIGURED' });
    }
    expect(JSON.stringify(getData)).not.toMatch(/ADC|@|Fallback|FALLBACK|READY/);

    process.env.GEMINI_API_KEY = 'mock-test-gemini-key-1122334455';
    const geminiRes = await app.request('/v1/system/providers', { headers: adminHeaders });
    const geminiData = await geminiRes.json();
    expect(geminiData.providers.gemini).toMatchObject({ configured: true, preview: 'mock...4455', status: 'KEY_SET' });
    delete process.env.GEMINI_API_KEY;

    // Browser changes cannot diverge Core from the worker or disappear on restart.
    const res=await app.request('/v1/system/providers',{method:'POST',headers:adminHeaders,
      body:JSON.stringify({openaiApiKey:'mock-test-openai-key',anthropicApiKey:'mock-test-anthropic-key'})});
    expect(res.status).toBe(409);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // Restore the environment the test found
    for (const [envVar, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[envVar];
      else process.env[envVar] = value;
    }
  });

  it('deduplicates clients in GET /v1/clients and provides verified KAAE DNA', async () => {
    const res = await app.request('/v1/clients');
    expect(res.status).toBe(200);
    const clients = await res.json();
    expect(Array.isArray(clients)).toBe(true);

    // Verify no duplicate client IDs exist
    const clientIds = clients.map((c: any) => c.clientId);
    const uniqueIds = new Set(clientIds);
    expect(clientIds.length).toBe(uniqueIds.size);

    // Verify KAAE exists exactly once
    const kaaeClients = clients.filter((c: any) => c.clientId === 'c1000000-0000-4000-8000-000000000002');
    expect(kaaeClients.length).toBe(1);
    expect(kaaeClients[0].name).toContain('Kurdistan Accrediting Association');

    // Verify DNA endpoint works for KAAE
    const dnaRes = await app.request('/v1/clients/c1000000-0000-4000-8000-000000000002/dna');
    expect(dnaRes.status).toBe(200);
    const dna = await dnaRes.json();
    expect(dna.name).toContain('Kurdistan Accrediting Association');
    expect(dna.fonts[0].family).toContain('Crimson Pro'); // ADR-238: the 2025 guideline's title face
  });
});
