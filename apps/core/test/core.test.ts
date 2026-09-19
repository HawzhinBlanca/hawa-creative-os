import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { createHash } from 'node:crypto';

describe('Core API: Ingress & Task Lifecycle', () => {
  const exports = memoryExportStore();
  const app = createApp({ deliverableStore: exports.store });

  it('responds to health checks', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('healthy');
  });

  it('rejects unauthenticated telegram webhook', async () => {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts authenticated telegram webhook and creates task', async () => {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 101,
        message: { text: 'New poster request', chat: { id: 777 } },
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.task.status).toBe('RECEIVED');
  });

  it('handles authenticated telegram webhook with auto-generation into AWAITING_APPROVAL and QA report', async () => {
    const res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1011,
        message: {
          text: 'دەستپێکردنی خولی باوەڕپێدانی زانکۆکانی کەی ئەی ئەی ئی ٢٠٢٦',
          chat: { id: 9988 },
          from: { id: 9988, first_name: 'Hawzhin', username: 'hawzhin' },
        },
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.task.sourcePlatform).toBe('telegram');
    expect(json.task.clientId).toBe('c1000000-0000-4000-8000-000000000002');
    expect(['RECEIVED', 'AWAITING_APPROVAL']).toContain(json.task.status);
    if (json.task.latestQAReport) {
      expect(json.task.latestQAReport.criticalPass).toBe(true);
    }
  });

  it('handles telegram bot slash commands via webhook (/status)', async () => {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1012,
        message: { text: '/status', chat: { id: 9988 } },
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.command).toBe(true);
    expect(json.reply.text).toContain('Hawa Telegram Bridge Status');
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

  it('deduplicates identical incoming event', async () => {
    const payload = JSON.stringify({
      update_id: 102,
      message: { text: 'Duplicate test', chat: { id: 777 } },
    });
    const res1 = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    expect(res1.status).toBe(201);

    const res2 = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    expect(res2.status).toBe(200);
    const json = await res2.json();
    expect(json.duplicate).toBe(true);
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
      body: JSON.stringify({ clientId: 'client-office-1', reason: 'Client assigned' }),
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

    // 4c. Test Content-Addressed Export Package Assembler (FR-045)
    const pkgRes = await app.request(`/v1/tasks/${taskId}/export-package`);
    expect(pkgRes.status).toBe(200);
    const pkgData = await pkgRes.json();
    expect(pkgData.packageHash).toBeDefined();
    expect(pkgData.files.length).toBeGreaterThanOrEqual(4);
    expect(pkgData.files.some((f: any) => f.name.endsWith('.hyc'))).toBe(true);

    // 5. QA really ran on the generated design. The generic generator draws a placeholder logo hash,
    //    so the official client logo is missing and QA fails (it used to be a literal all-pass report).
    expect(currentTask.latestQAReport.criticalPass).toBe(false);
    expect(currentTask.latestQAReport.findings.map((f: any) => f.ruleId)).toContain('OFFICIAL_LOGO_MISSING_OR_MUTATED');

    // 6. A design failing critical QA cannot be approved
    const approveRes = await app.request(`/v1/tasks/${taskId}/revisions/${currentTask.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director_1',
        pinnedExportIds: [exports.add(taskId)],
      }),
    });
    expect(approveRes.status).toBe(412);
    expect((await (await app.request(`/v1/tasks/${taskId}`)).json()).status).toBe('AWAITING_APPROVAL');

    // 7. Check timeline
    const timelineRes = await app.request(`/v1/tasks/${taskId}/timeline`);
    const timeline = await timelineRes.json();
    expect(timeline.events.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces repair budget of max 2 cycles on revision requests', async () => {
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Revision Test' }),
    });
    const { id: taskId } = await createRes.json();

    // Route and Generate
    await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-office-1' }),
    });
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });

    const revCheck = await app.request(`/v1/tasks/${taskId}`);
    const { latestRevisionId } = await revCheck.json();

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
    expect(health.items.length).toBe(6);

    // Operations Failures
    const failRes = await app.request('/v1/operations/failures');
    expect(failRes.status).toBe(200);
  });

  it('streams real-time Server-Sent Events (SSE) and broadcasts task mutations', async () => {
    const streamRes = await app.request('/v1/events/stream');
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

    // 2. Trigger task creation while stream is actively listening
    const createPromise = app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `sse-stream-test-${Date.now()}`,
      },
      body: JSON.stringify({
        title: 'SSE Stream Verification Task',
        priority: 'routine',
      }),
    });

    const [postRes, secondChunk] = await Promise.all([
      createPromise,
      reader!.read(),
    ]);

    expect(postRes.status).toBe(201);
    expect(secondChunk.done).toBe(false);
    const secondText = new TextDecoder().decode(secondChunk.value);
    expect(secondText).toContain('event: task:created');
    expect(secondText).toContain('SSE Stream Verification Task');

    // 3. Clean abort stream
    await reader!.cancel();
  });

  it('GET /v1/operations/slo & POST /v1/operations/slo/run tracks synthetic latency & percentiles', async () => {
    // 1. Get initial SLO summary
    const getRes = await app.request('/v1/operations/slo');
    expect(getRes.status).toBe(200);
    const slo = await getRes.json();
    // No seeded probes: the daemon starts empty and every data point comes from a probe that ran.
    expect(slo.summary.totalProbes).toBe(0);
    expect(slo.summary.circuitBreakers.length).toBe(4);

    // 2. Trigger on-demand synthetic campaign benchmark
    const runRes = await app.request('/v1/operations/slo/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'nawroz_spring' }),
    });
    expect(runRes.status).toBe(201);
    const runBody = await runRes.json();
    expect(runBody.result.success).toBe(true);
    expect(runBody.result.invariantsVerified.deterministicQaPassed).toBe(true);
    expect(runBody.summary.totalProbes).toBe(slo.summary.totalProbes + 1);
    expect(runBody.summary.successRate).toBe(100);
    expect(runBody.summary.p99DurationMs).toBeGreaterThan(0);
  });

  it('GET /v1/operations/reconciliation & POST /v1/operations/reconciliation/run audit drift and refuse auto-repair (FR-049, FR-050)', async () => {
    // 1. Before any audit there is no report, not an invented clean one
    const getRes = await app.request('/v1/operations/reconciliation');
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toBeNull();

    // 2. Auto-repair is refused: Core cannot upload to Drive or write Sheets from here
    const repairRes = await app.request('/v1/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoRepair: true }),
    });
    expect(repairRes.status).toBe(422);
    expect((await repairRes.json()).title).toBe('Auto-Repair Not Available');

    // 3. The audit runs and says what it compared
    const runRes = await app.request('/v1/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(runRes.status).toBe(201);
    const runReport = await runRes.json();
    expect(runReport.auditId).toBeDefined();
    expect(['clean', 'divergent']).toContain(runReport.status);
    expect(runReport.simulated).toBe(false);
    expect(runReport.basis).toContain('Google Drive and Google Sheets were not read');
    expect(runReport).not.toHaveProperty('repairedCount');
    expect(runReport.totalTasksAudited).toBeGreaterThanOrEqual(1);

    const latest = await (await app.request('/v1/operations/reconciliation')).json();
    expect(latest.auditId).toBe(runReport.auditId);
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

    // 6. Approval is refused while critical QA fails
    const decisionRes = await app.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director',
        pinnedExportIds: [exports.add(taskId)],
      }),
    });
    expect(decisionRes.status).toBe(412);

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

  it('inspects Kurdish WebFont coverage, tracks AI budgets, mines feedback deltas, and provides client-scoped omnisearch', async () => {
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

    // 2. Budget Inspection and Allocation
    const budgetRes = await app.request('/v1/clients/client-drustee/budget');
    expect(budgetRes.status).toBe(200);
    const budgetData = await budgetRes.json();
    expect(budgetData.capUsd).toBe(10.0);
    expect(budgetData.status).toBe('HEALTHY');

    const allocRes = await app.request('/v1/clients/client-drustee/budget/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capUsd: 15.0 }),
    });
    expect(allocRes.status).toBe(200);
    const allocData = await allocRes.json();
    expect(allocData.capUsd).toBe(15.0);

    // 3. Governed Learning & Feedback Mining
    const mineRes = await app.request('/v1/feedback/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-drustee',
        taskId: 'task-test-learn-1',
        initialArtboard: {
          taskId: 'task-test-learn-1',
          clientId: 'client-drustee',
          layers: [{ id: 'title', type: 'text', color: '#111827', lineHeight: 1.2, x: 50, y: 50, width: 200, height: 50 }],
        },
        finalArtboard: {
          taskId: 'task-test-learn-1',
          clientId: 'client-drustee',
          layers: [{ id: 'title', type: 'text', color: '#01585F', lineHeight: 1.52, x: 50, y: 90, width: 200, height: 50 }],
        },
      }),
    });
    expect(mineRes.status).toBe(201);
    const mineData = await mineRes.json();
    expect(mineData.count).toBeGreaterThan(0);

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
    expect(['RECEIVED', 'BRIEF_READY']).toContain(data.task.status);
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

    // 3. Fetch CDN Font binary
    const fontRes = await app.request('/v1/fonts/cdn/AsterKurdishTitle/font.woff2');
    expect(fontRes.status).toBe(200);
    expect(fontRes.headers.get('Content-Type')).toBe('font/woff2');
    expect(fontRes.headers.get('Cache-Control')).toContain('immutable');
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
    const callbackRes = await app.request(actionUrl, { method: 'GET' });
    expect(callbackRes.status).toBe(200);
    const htmlText = await callbackRes.text();
    expect(htmlText).toContain('کەمپینەکە بەسەرکەوتوویی پەسەندکرا');

    // 4. Verify task state is updated to APPROVED
    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('APPROVED');
  });

  it('publishes exactly the pinned export to the client\'s Google Drive and Sheets, with an emulated receipt', async () => {
    // 1. Create and approve task
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The Drustee template needs a headline and body; it refuses (COPY_REQUIRED) rather than drawing sample text.
      body: JSON.stringify({ title: 'Omnichannel Publishing Test', clientId: 'client-drustee', headlineEn: 'Omnichannel Publishing Test', copyEn: 'Vitamin D3 + K2, laboratory tested.' }),
    });
    const { id: taskId } = await createRes.json();

    // Transition to APPROVED
    await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-drustee' }),
    });
    // A submitted revision (generated designs fail real QA until the generators are fixed).
    const revRes = await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'Omnichannel Publishing Test' }] } }),
    });
    const { revisionId: latestRevisionId } = await revRes.json();
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
    expect(receipt.emulated).toBe(true);
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

  it('never writes provider credentials to a configuration file', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };
    const candidates = ['infra/docker/.env.production', '.env.production', '.env.local', '../../infra/docker/.env.production'].map((p) => path.resolve(process.cwd(), p));
    const before = candidates.map((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null));
    const res = await app.request('/v1/system/providers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ anthropicApiKey: 'mock-never-written-key-1234567890', wahaEndpoint: 'http://127.0.0.1:3000' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.persisted).toBe(false);
    expect(data.activated).toEqual(['ANTHROPIC_API_KEY', 'WAHA_ENDPOINT']);
    const after = candidates.map((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null));
    expect(after).toEqual(before);
  });

  it('rejects a key the provider refuses and changes nothing', async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };
    const savedVitest = process.env.VITEST;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const realFetch = globalThis.fetch;
    delete process.env.VITEST; // leave the fixture path so the live verifier runs, against a stubbed provider
    globalThis.fetch = (async () => new Response('{"error":"invalid"}', { status: 401 })) as any;
    try {
      const res = await app.request('/v1/system/providers', {
        method: 'POST',
        headers,
        body: JSON.stringify({ anthropicApiKey: 'rejected-key-0000000000000000' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.title).toBe('PROVIDER_KEY_REJECTED');
      expect(body.detail).not.toContain('rejected-key-0000000000000000');
      expect(process.env.ANTHROPIC_API_KEY).toBe(savedKey);
    } finally {
      globalThis.fetch = realFetch;
      process.env.VITEST = savedVitest;
    }
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

    // 2. Update credentials
    const postRes = await app.request('/v1/system/providers', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        openaiApiKey: 'mock-test-openai-key-1234567890',
        anthropicApiKey: 'mock-test-anthropic-key-0987654321',
      }),
    });
    expect(postRes.status).toBe(200);
    const postData = await postRes.json();
    expect(postData.ok).toBe(true);

    // 3. Verify in-memory activation
    expect(process.env.OPENAI_API_KEY).toBe('mock-test-openai-key-1234567890');
    expect(process.env.ANTHROPIC_API_KEY).toBe('mock-test-anthropic-key-0987654321');

    const verifyRes = await app.request('/v1/system/providers', {
      headers: adminHeaders,
    });
    const verifyData = await verifyRes.json();
    expect(verifyData.providers.openai.configured).toBe(true);
    expect(verifyData.providers.openai.preview).toContain('mock...7890');
    expect(verifyData.providers.anthropic.configured).toBe(true);
    expect(verifyData.providers.anthropic.preview).toContain('mock...4321');

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
    expect(dna.fonts[0].family).toContain('Cinzel');
  });
});


