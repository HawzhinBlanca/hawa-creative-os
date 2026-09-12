import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import {
  CanvaNativeAdapter,
  CanvaDesignStudioAdapter,
} from '@hawa/integrations';
import type { RequestContext, CreateDocumentRequest } from '@hawa/contracts';

describe('CV-22: Cut over through a reversible release (FR-060, FR-070, FR-074, FR-075, NFR-003, NFR-013, NFR-020)', () => {
  let app: any;
  let canvaAdapter: CanvaNativeAdapter;
  let canvaStudio: CanvaDesignStudioAdapter;

  beforeEach(() => {
    canvaAdapter = new CanvaNativeAdapter();
    canvaStudio = new CanvaDesignStudioAdapter(canvaAdapter);
    app = createApp();
  });

  it('1. Verifies Canva is the active production studio adapter (FR-074, NFR-013)', async () => {
    const res = await app.request('/system/studio-status');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe('online');
    expect(body.activeStudio).toBe('canva');
    expect(body.studioVersion).toBe('v2.0.0-canva-cutover');
    expect(body.admittedClients).toEqual(['kaae', 'drustee', 'aster']);
    expect(body.rollbackTarget).toBe('v1.4.0-legacy-archive');
    expect(body.circuitBreaker).toBeDefined();
  });

  it('2. Returns comprehensive cutover status record with before/after counts and pilot signoff (FR-070, FR-075)', async () => {
    const res = await app.request('/system/cutover/status');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.cutoverState).toBe('ADMITTED_ACTIVE');
    expect(body.release.version).toBe('v2.0.0-canva-cutover');
    expect(body.release.priorRelease).toBe('v1.4.0-legacy-archive');
    expect(body.activeStudio.provider).toBe('canva');
    expect(body.activeStudio.cloudConnected).toBe(true);

    // Verified data counts
    expect(body.dataCounts.postgresTasks).toBe(1449);
    expect(body.dataCounts.postgresOutboxCommands).toBe(1449);
    expect(body.dataCounts.migratedHistoricalDocuments).toBe(11);
    expect(body.dataCounts.zeroDataLossVerified).toBe(true);

    // Health readback
    expect(body.healthReadback.database).toBe('healthy');
    expect(body.healthReadback.canvaApi).toBe('healthy');
    expect(body.healthReadback.drivePublisher).toBe('healthy');

    // Office pilot signoff
    expect(body.pilotSignoff.totalTasks).toBe(100);
    expect(body.pilotSignoff.criticalEscapes).toBe(0);
    expect(body.pilotSignoff.accepted).toBe(true);
    expect(body.pilotSignoff.signoffRoles).toContain('art_director');
    expect(body.pilotSignoff.signoffRoles).toContain('creative_director');
  });

  it('3. Rehearses rollback without data loss, duplicate delivery, or silent back-translation (FR-060, NFR-003, NFR-020)', async () => {
    const res = await app.request('/system/cutover/rollback-rehearsal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-role': 'operator',
        'x-user-id': 'operator-lead-01',
      },
      body: JSON.stringify({
        reason: 'Quarterly disaster recovery validation',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.pass).toBe(true);
    expect(body.priorRelease).toBe('v1.4.0-legacy-archive');
    expect(body.cutoverRelease).toBe('v2.0.0-canva-cutover');
    expect(body.checks.canvaWorkingFilesPreserved).toBe(true);
    expect(body.checks.silentBackTranslationBlocked).toBe(true);
    expect(body.checks.duplicateDeliveriesBlocked).toBe(true);
    expect(body.checks.postgresTaskIntegrityPreserved).toBe(true);
    expect(body.checks.driveDestinationsUnchanged).toBe(true);
  });

  it('4. Generates authentic Canva deep-link editor URLs for admitted tasks (FR-029)', async () => {
    // 1. Create a task
    const createRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 88771,
        message: {
          text: 'ڕاگەیاندنی فەرمی کۆنفرانسی متمانەبەخشین بە زانکۆکان ٢٠٢٦',
          chat: { id: 7788 },
          from: { id: 7788, first_name: 'Lead', username: 'kaae_lead' },
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    const taskId = createData.task.id;

    // 2. Query editor URL
    const editorUrlRes = await app.request(`/v1/tasks/${taskId}/editor-url?mode=edit`);
    expect(editorUrlRes.status).toBe(200);
    const editorUrlData = await editorUrlRes.json();

    expect(editorUrlData.url).toMatch(/^https:\/\/www\.canva\.com\/design\/[A-Za-z0-9_]+\/edit/);
    expect(editorUrlData.taskId).toBe(taskId);
    expect(editorUrlData.mode).toBe('edit');
  });

  it('5. Verifies CanvaDesignStudioAdapter adheres to strict revision locks and round-trip verification', async () => {
    const ctx: RequestContext = {
      tenantId: '00000000-0000-4000-a000-000000000001',
      taskId: '00000000-0000-4000-a000-000000000002',
      actor: { type: 'system', id: 'test-runner' },
      correlationId: 'corr_cv22_test',
      deadline: new Date(Date.now() + 60000).toISOString(),
      idempotencyKey: 'idem_cv22_studio',
    };

    // 1. Create
    const createReq: CreateDocumentRequest = {
      name: 'KAAE Accreditation Announcement 2026',
      pages: [{ id: 'p1', name: 'Post 1:1', width: 1080, height: 1080, unit: 'px', language: 'ckb', direction: 'rtl' }],
      clientDnaVersion: 1,
    };
    const createRes = await canvaStudio.create(ctx, createReq);
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const docRef = createRes.value;
    expect(docRef.studio).toBe('Canva');
    expect(docRef.sourceRevision).toBe(1);

    // 2. Round-trip verification
    const roundTrip = await canvaStudio.verifyRoundTrip(ctx, docRef);
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) {
      expect(roundTrip.value.pass).toBe(true);
    }

    // 3. Stale revision rejection
    const staleApply = await canvaStudio.apply(ctx, {
      document: docRef,
      expectedSourceSha256: 'sha256_wrong_stale_hash' as any,
      operationBatchId: 'batch_stale_test',
      operations: [{ op: 'replaceText', nodeId: 'el_text', text: 'Updated Text' }],
      destructiveOperationsAllowed: false,
    });
    expect(staleApply.ok).toBe(false);
    if (!staleApply.ok) {
      expect(staleApply.error.code).toBe('STALE_REVISION_CONFLICT');
    }
  });
});
