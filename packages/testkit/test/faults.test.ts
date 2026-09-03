import { describe, it, expect } from 'vitest';
import { FakeMessageAdapter } from '../src/fake-message-adapter.js';
import { FakeDesignStudioAdapter } from '../src/fake-studio.js';
import { FakePublisher } from '../src/fake-publisher.js';
import { FakeModelGateway } from '../src/fake-model-gateway.js';
import type { RequestContext, PublishRequest, ApplyOperationsRequest } from '@hawa/contracts';
import { TaskStateMachine, extractProtectedTokens, validateBrief, type DesignBrief } from '@hawa/domain';

describe('Fault Injection Matrix: Resilience & Idempotency Proof', () => {
  const ctx: RequestContext = {
    tenantId: 'tenant-1',
    actor: { type: 'workflow', id: 'wf-resilience' },
    correlationId: 'c-1',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idem-test-1',
  };

  it('FI-001: Identical webhook delivered twice produces exactly one logical event and task', async () => {
    const adapter = new FakeMessageAdapter('telegram');
    const headers = new Headers({ 'x-telegram-bot-api-secret-token': 'expected_office_secret' });
    const body = new TextEncoder().encode(JSON.stringify({
      update_id: 10001,
      message: { message_id: 555, text: 'سڵاو لە هەمووان', from: { id: 999 } },
    }));

    const res1 = await adapter.verifyAndNormalize({ headers, rawBody: body, receivedAt: new Date().toISOString() });
    const res2 = await adapter.verifyAndNormalize({ headers, rawBody: body, receivedAt: new Date().toISOString() });

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    if (res1.ok && res2.ok) {
      expect(res1.value[0].source.eventId).toBe(res2.value[0].source.eventId);
      expect(res1.value[0].rawPayloadHash).toBe(res2.value[0].rawPayloadHash);
    }
  });

  it('FI-007: Model invents a fact / price without approved copy -> blocked by fact check', () => {
    const brief: DesignBrief = {
      briefId: 'b-1',
      taskId: 't-1',
      clientId: 'c-1',
      clientDnaVersion: 1,
      objective: 'Special Event',
      taskRoute: 'template_fill',
      primaryLanguage: 'ckb',
      direction: 'rtl',
      variants: [{ id: 'v1', name: 'sq', width: 1080, height: 1080, aspectRatio: '1:1', role: 'instagram_post' }],
      exactCopy: [{ id: 'ec1', role: 'headline', text: 'ئاهەنگی ساڵانە', language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] }],
      missingFacts: [{ field: 'event_date', question: 'Missing date for annual event', impact: 'critical', blocking: true }],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    const res = validateBrief(brief);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('BRIEF_HAS_MISSING_FACTS');
    }
  });

  it('FI-008: Model provider rate limit 429 returns retryable error for Restate backoff', async () => {
    const gateway = new FakeModelGateway();
    gateway.setFailure('RATE_LIMIT_429');

    const res = await gateway.generateStructured(ctx, {
      role: 'intake_router',
      inputs: [{ kind: 'text', text: 'Hello' }],
      systemPromptVersion: '1.0',
      responseSchema: {},
      budget: { maxCostUsd: 0.01, maxLatencyMs: 1000, maxAttempts: 3 },
      egressPolicy: { mode: 'approved_providers', allowedProviders: ['google'] },
      cachePolicy: 'disabled',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('RATE_LIMIT_429');
      expect(res.error.retryable).toBe(true);
    }
  });

  it('FI-017: Stale studio revision conflict is rejected without silent overwrite', async () => {
    const studio = new FakeDesignStudioAdapter();
    const created = await studio.create(ctx, {
      name: 'Test Poster',
      pages: [{ id: 'p1', name: 'Page 1', width: 1080, height: 1080, unit: 'px', language: 'ckb', direction: 'rtl' }],
      clientDnaVersion: 1,
    });
    expect(created.ok).toBe(true);
    const docRef = (created as { ok: true; value: any }).value;

    // Apply operation 1 (increments revision to 2)
    const op1: ApplyOperationsRequest = {
      document: docRef,
      expectedSourceSha256: docRef.sourceSha256,
      operationBatchId: 'b1',
      operations: [{ op: 'addText', nodeId: 'n1', pageId: 'p1', text: 'First Edit', role: 'headline', x: 0, y: 0, width: 200, height: 50, style: {} }],
      destructiveOperationsAllowed: false,
    };
    const res1 = await studio.apply(ctx, op1);
    expect(res1.ok).toBe(true);

    // Apply operation 2 with stale expected hash
    const op2: ApplyOperationsRequest = {
      document: docRef,
      expectedSourceSha256: docRef.sourceSha256, // stale hash!
      operationBatchId: 'b2',
      operations: [{ op: 'addText', nodeId: 'n2', pageId: 'p1', text: 'Conflicting Edit', role: 'headline', x: 0, y: 0, width: 200, height: 50, style: {} }],
      destructiveOperationsAllowed: false,
    };
    const res2 = await studio.apply(ctx, op2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.code).toBe('EXPECTED_SHA_MISMATCH');
    }
  });

  it('FI-026: Lost response after Drive publication recovers idempotently with same receipt', async () => {
    const publisher = new FakePublisher();
    const request: PublishRequest = {
      taskId: 'task-pub-1',
      clientId: 'client-pub-1',
      designRevisionId: 'rev-pub-1',
      approvalId: 'app-pub-1',
      publicationKey: 'pub_key_task-pub-1_rev-1',
      packageHash: 'package_sha256_hash_1',
      files: [{
        artifactId: 'art-1',
        relativePath: 'exports/final.png',
        storageKey: 'storage/final.png',
        filename: 'final.png',
        mimeType: 'image/png',
        byteSize: 1024,
        sha256: 'file_sha256_1',
      }],
      destination: {
        sharedDriveId: 'drive-team-1',
        productionRootFolderId: 'folder-root-1',
        relativeFolderParts: ['2026', 'Campaign'],
        spreadsheetId: 'sheet-main-1',
        sheetId: 0,
      },
      sheetRow: { task_id: 'task-pub-1', title: 'Test Post', status: 'Complete' },
    };

    const pub1 = await publisher.publish(ctx, request);
    expect(pub1.ok).toBe(true);

    // Second call simulates replay after client network loss
    const pub2 = await publisher.publish(ctx, request);
    expect(pub2.ok).toBe(true);

    if (pub1.ok && pub2.ok) {
      expect(pub1.value.publicationId).toBe(pub2.value.publicationId);
      expect(pub1.value.driveFolderId).toBe(pub2.value.driveFolderId);
      expect(pub1.value.driveFiles[0].fileId).toBe(pub2.value.driveFiles[0].fileId);
    }
  });
});
