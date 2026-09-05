import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Core API: Ingress & Task Lifecycle', () => {
  const app = createApp();

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

  it('executes end-to-end task progression: route -> brief -> generate -> decide -> publish', async () => {
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
    expect(editorUrlData.url).toContain('/review?doc=');
    expect(editorUrlData.taskId).toBe(taskId);

    // 4c. Test Content-Addressed Export Package Assembler (FR-045)
    const pkgRes = await app.request(`/v1/tasks/${taskId}/export-package`);
    expect(pkgRes.status).toBe(200);
    const pkgData = await pkgRes.json();
    expect(pkgData.packageHash).toBeDefined();
    expect(pkgData.files.length).toBeGreaterThanOrEqual(4);
    expect(pkgData.files.some((f: any) => f.name.endsWith('.hyc'))).toBe(true);

    // 5. Decide (Approve)
    const approveRes = await app.request(`/v1/tasks/${taskId}/revisions/${currentTask.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director_1',
      }),
    });
    expect(approveRes.status).toBe(201);

    // 6. Publish task
    const pubRes = await app.request(`/v1/tasks/${taskId}/publish`, {
      method: 'POST',
    });
    expect(pubRes.status).toBe(202);

    const completedCheck = await app.request(`/v1/tasks/${taskId}`);
    const completedTask = await completedCheck.json();
    expect(completedTask.status).toBe('COMPLETE');

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
    expect(slo.summary.totalProbes).toBeGreaterThanOrEqual(12);
    expect(slo.summary.successRate).toBe(100);
    expect(slo.summary.p99DurationMs).toBeGreaterThan(0);
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
  });

  it('GET /v1/operations/reconciliation & POST /v1/operations/reconciliation/run audits and repairs storage drift (FR-049, FR-050)', async () => {
    // 1. Get initial reconciliation report
    const getRes = await app.request('/v1/operations/reconciliation');
    expect(getRes.status).toBe(200);
    const report = await getRes.json();
    expect(report.totalTasksAudited).toBeGreaterThanOrEqual(0);

    // 2. Trigger active reconciliation audit
    const runRes = await app.request('/v1/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoRepair: true }),
    });
    expect(runRes.status).toBe(201);
    const runReport = await runRes.json();
    expect(runReport.auditId).toBeDefined();
    expect(['clean', 'repaired']).toContain(runReport.status);
    expect(runReport.totalTasksAudited).toBeGreaterThanOrEqual(1);
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

  it('executes complete end-to-end task lifecycle for Drustee (Ingress ➔ Route ➔ Brief ➔ Generate ➔ Approve ➔ Publish)', async () => {
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

    // 5. Human Decision (Approval)
    const decisionRes = await app.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director',
        notes: 'Passed all visual quality, Kurdish orthography, and WCAG contrast diagnostics.',
      }),
    });
    expect(decisionRes.status).toBe(201);

    // 6. Publish Deliverables (Idempotent Publisher)
    const pubRes = await app.request(`/v1/tasks/${taskId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(pubRes.status).toBe(202);
    const pubData = await pubRes.json();
    expect(pubData.taskId).toBe(taskId);

    // Verify task is in COMPLETE terminal status
    const finalTaskRes = await app.request(`/v1/tasks/${taskId}`);
    const finalTask = await finalTaskRes.json();
    expect(finalTask.status).toBe('COMPLETE');

    // Verify timeline has full audit trail
    const timelineRes = await app.request(`/v1/tasks/${taskId}/timeline`);
    const timeline = await timelineRes.json();
    expect(timeline.events.length).toBeGreaterThanOrEqual(5);
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
});

