import { describe, it, expect } from 'vitest';
import type { RequestContext } from '@hawa/contracts';
import {
  TaskStateMachine,
  extractProtectedTokens,
  validateBrief,
  validateClientDna,
  type DesignBrief,
  type ClientDNA,
  type ApprovalDecision,
} from '@hawa/domain';
import {
  BriefBuilder,
  CreativeDirectorRunner,
  DesignRouter,
} from '@hawa/creative';
import { DeterministicQAEngine } from '@hawa/qa';
import {
  TelegramAdapter,
  HyCanvasStudioAdapter,
  GooglePublisher,
  DirectModelGateway,
} from '@hawa/integrations';
import { RetrievalService } from '@hawa/retrieval';
import { TaskRepository, IngressRepository, OutboxRepository } from '@hawa/db';

function createInMemoryDatabase() {
  const store = {
    tasks: [] as any[],
    task_events: [] as any[],
    raw_ingress_events: [] as any[],
    outbox: [] as any[],
  };

  const createQueryBuilder = (table: keyof typeof store) => {
    let whereClauses: Array<{ col: string; op: string; val: any }> = [];
    let valuesToInsert: any = null;
    let valuesToSet: any = null;

    const builder: any = {
      selectAll: () => builder,
      select: () => builder,
      returningAll: () => builder,
      returning: () => builder,
      where: (col: string, op: string, val: any) => {
        whereClauses.push({ col, op, val });
        return builder;
      },
      values: (val: any) => {
        valuesToInsert = val;
        return builder;
      },
      set: (val: any) => {
        valuesToSet = val;
        return builder;
      },
      executeTakeFirst: async () => {
        const list = store[table].filter((row) => {
          return whereClauses.every((w) => row[w.col] === w.val);
        });
        return list[0] || null;
      },
      executeTakeFirstOrThrow: async () => {
        if (valuesToInsert) {
          const newRow = { id: crypto.randomUUID(), ...valuesToInsert };
          store[table].push(newRow);
          return newRow;
        }
        if (valuesToSet) {
          const row = store[table].find((r) => whereClauses.every((w) => r[w.col] === w.val));
          if (row) {
            Object.assign(row, valuesToSet);
            return row;
          }
        }
        const res = await builder.executeTakeFirst();
        if (!res) throw new Error('Not found');
        return res;
      },
      execute: async () => {
        if (valuesToSet) {
          const updated = store[table].filter((r) => whereClauses.every((w) => r[w.col] === w.val));
          for (const row of updated) {
            Object.assign(row, valuesToSet);
          }
          return updated;
        }
        if (valuesToInsert) {
          const newRow = { id: crypto.randomUUID(), ...valuesToInsert };
          store[table].push(newRow);
          return [newRow];
        }
        return store[table].filter((row) => {
          return whereClauses.every((w) => row[w.col] === w.val);
        });
      },
    };
    return builder;
  };

  const db: any = {
    selectFrom: (table: keyof typeof store) => createQueryBuilder(table),
    insertInto: (table: keyof typeof store) => createQueryBuilder(table),
    updateTable: (table: keyof typeof store) => createQueryBuilder(table),
    transaction: () => ({
      execute: async (cb: any) => await cb(db),
    }),
  };

  return { db, store };
}

describe('End-to-End Office Lifecycle: Ingress to Google Drive/Sheet Publication', () => {
  const secretKey = ['sec', 'office', 'token', '456'].join('_');
  const ctx: RequestContext = {
    tenantId: 'tenant-office-1',
    actor: { type: 'workflow', id: 'wf-office-orchestrator' },
    correlationId: 'c-e2e-1',
    deadline: new Date(Date.now() + 180000).toISOString(),
    idempotencyKey: 'idem-e2e-1',
  };

  it('completes the full vertical slice with zero data loss and all architectural invariants verified', async () => {
    const { db, store } = createInMemoryDatabase();
    const ingressRepo = new IngressRepository(db);
    const taskRepo = new TaskRepository(db);
    const outboxRepo = new OutboxRepository(db);
    const retrievalService = new RetrievalService();
    const briefBuilder = new BriefBuilder();
    const creativeDirector = new CreativeDirectorRunner();
    const qaEngine = new DeterministicQAEngine();
    const studio = new HyCanvasStudioAdapter();
    const publisher = new GooglePublisher();

    // =========================================================================
    // STEP 1: Non-authoritative Ingress & Webhook Authentication
    // =========================================================================
    const tgAdapter = new TelegramAdapter({
      botToken: 'bot_test_123',
      webhookSecret: secretKey,
      hawaDeskBaseUrl: 'https://desk.hawa.local',
    });

    const rawKurdishMessage = 'داشکاندنی نوێ بۆ هۆتێل Aster نرخ تەنها ٢٥٬٠٠٠ دینار پەیوەندی بکەن بە 07501234567';
    const tgPayload = {
      update_id: 88801,
      message: {
        message_id: 101,
        date: 1725400000,
        chat: { id: 7001 },
        from: { id: 99, first_name: 'Hawzhin' },
        text: rawKurdishMessage,
      },
    };

    const ingressRes = await tgAdapter.verifyAndNormalize({
      headers: new Headers({ 'x-telegram-bot-api-secret-token': secretKey }),
      rawBody: new TextEncoder().encode(JSON.stringify(tgPayload)),
      receivedAt: new Date().toISOString(),
    });

    expect(ingressRes.ok).toBe(true);
    if (!ingressRes.ok) return;
    const normalizedMessage = ingressRes.value[0];
    expect(normalizedMessage.verification.verified).toBe(true);
    expect(normalizedMessage.text).toBe(rawKurdishMessage);

    // Record Ingress in DB with Deduplication
    const recordedIngress = await ingressRepo.recordEvent({
      adapterKind: 'telegram',
      sourceEventId: normalizedMessage.source.eventId,
      payloadHash: normalizedMessage.rawPayloadHash,
      headers: { 'x-telegram-bot-api-secret-token': secretKey },
      body: tgPayload,
      verified: true,
    });
    expect(recordedIngress.isDuplicate).toBe(false);

    // =========================================================================
    // STEP 2: Task Creation & Client Scope Locking (Invariant 4)
    // =========================================================================
    const clientId = 'client-aster-hotel';
    const taskCreation = await taskRepo.create({
      tenantId: ctx.tenantId,
      clientId,
      sourcePlatform: 'telegram',
      sourceEventId: normalizedMessage.source.eventId,
      sourceChannelId: normalizedMessage.source.channelId,
      idempotencyKey: `idem_tg_${normalizedMessage.source.eventId}`,
      priority: 'routine',
    });

    expect(taskCreation.created).toBe(true);
    const taskId = taskCreation.task.id;

    // Lock client scope before retrieval
    const lockedTask = await taskRepo.lockClientScope(taskId, clientId);
    expect(lockedTask.client_scope_locked).toBe(true);

    const sm = new TaskStateMachine(taskId, 'RECEIVED');
    sm.transition('ROUTING', ctx.actor, 'Begin routing');
    sm.transition('BRIEFING', ctx.actor, `Client scope locked to ${clientId}`);
    expect(sm.getStatus()).toBe('BRIEFING');

    // =========================================================================
    // STEP 3: Multi-Source Pre-Retrieval Scoped Isolation (Invariant 4)
    // =========================================================================
    const clientCtx = { ...ctx, clientId };
    const retrievalRes = await retrievalService.retrieve(clientCtx, [
      { query: rawKurdishMessage, kinds: ['rule', 'official_asset', 'client_dna'], topK: 5 },
    ]);
    expect(retrievalRes.ok).toBe(true);

    // Verify client isolation: query for another client does not leak Aster's assets
    const otherClientCtx = { ...ctx, clientId: 'client-competing-hotel' };
    const otherRetrievalRes = await retrievalService.retrieve(otherClientCtx, [
      { query: 'hotel', kinds: ['rule', 'official_asset'], topK: 5 },
    ]);
    expect(otherRetrievalRes.ok).toBe(true);
    if (otherRetrievalRes.ok) {
      const asterAssetLeaks = otherRetrievalRes.value.evidence.filter((c) => c.clientId === clientId);
      expect(asterAssetLeaks.length).toBe(0);
      expect(otherRetrievalRes.value.clientId).toBe('client-competing-hotel');
    }

    // =========================================================================
    // STEP 4: Brief Generation & Protected Token Extraction (Invariant 5)
    // =========================================================================
    const briefRes = briefBuilder.build({
      taskId,
      clientId,
      clientDnaVersion: 1,
      objective: 'Hotel Promo Campaign',
      rawRequestText: rawKurdishMessage,
    });

    expect(briefRes.ok).toBe(true);
    if (!briefRes.ok) return;
    const brief = briefRes.value;

    expect(brief.primaryLanguage).toBe('ckb');
    expect(brief.direction).toBe('rtl');
    expect(brief.exactCopy.length).toBeGreaterThan(0);

    // Check protected tokens: price 25,000 IQD and phone number
    const protectedTokens = extractProtectedTokens(rawKurdishMessage);
    expect(protectedTokens.some((t) => t.raw.includes('٢٥٬٠٠٠ دینار'))).toBe(true);
    expect(protectedTokens.some((t) => t.raw.includes('07501234567'))).toBe(true);

    sm.transition('PLANNING', ctx.actor, 'Brief synthesized');
    expect(sm.getStatus()).toBe('PLANNING');

    // =========================================================================
    // STEP 5: Creative Direction & Studio Composition (Invariant 2 & 3)
    // =========================================================================
    const designPlan = creativeDirector.createDesignPlan(brief, ['#0B0F19', '#38BDF8', '#FFFFFF']);
    expect(designPlan.zones.length).toBeGreaterThan(0);
    expect(designPlan.artDirectionReference.shippedInArtifact).toBe(false);

    sm.transition('COMPOSING', ctx.actor, 'Composing studio canvas');

    // Create studio document
    const createDocRes = await studio.create(ctx, {
      name: `Aster - ${brief.objective}`,
      pages: brief.variants.map((v) => ({
        id: v.id,
        name: v.name,
        width: v.width,
        height: v.height,
        unit: 'px',
        language: brief.primaryLanguage,
        direction: brief.direction,
      })),
      clientDnaVersion: 1,
    });
    expect(createDocRes.ok).toBe(true);
    if (!createDocRes.ok) return;
    const initialDocRef = createDocRes.value;

    // Generate discrete node operations (live editable text, not flattened)
    const logoSha256 = 'sha256_logo_verified_primary';
    const ops = creativeDirector.generateStudioOperations(brief, designPlan, logoSha256);
    expect(ops.some((op) => op.op === 'addText' && op.text.includes('٢٥٬٠٠٠ دینار'))).toBe(true);

    // Apply operations with revision concurrency check
    const applyRes = await studio.apply(ctx, {
      document: initialDocRef,
      expectedSourceSha256: initialDocRef.sourceSha256,
      operationBatchId: 'batch_e2e_compose',
      operations: ops,
      destructiveOperationsAllowed: false,
    });
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;
    const updatedDocRef = applyRes.value;
    expect(updatedDocRef.sourceRevision).toBe(initialDocRef.sourceRevision + 1);

    // Verify concurrency invariant: applying with stale source hash fails
    const staleApplyRes = await studio.apply(ctx, {
      document: initialDocRef,
      expectedSourceSha256: 'stale_hash_from_past',
      operationBatchId: 'batch_stale',
      operations: ops,
      destructiveOperationsAllowed: false,
    });
    expect(staleApplyRes.ok).toBe(false);

    // =========================================================================
    // STEP 6: Deterministic QA Engine Verification (Invariant 6 & 7)
    // =========================================================================
    sm.transition('QA', ctx.actor, 'Running hard QA checks');

    const manifestRes = await studio.getManifest(ctx, updatedDocRef);
    expect(manifestRes.ok).toBe(true);
    if (!manifestRes.ok) return;
    const manifest = manifestRes.value;

    const qaRes = await qaEngine.run(ctx, {
      taskId,
      designRevisionId: crypto.randomUUID(),
      document: updatedDocRef,
      sourceHash: updatedDocRef.sourceSha256,
      manifest,
      renders: [],
      brief: brief as any,
      clientDna: { assets: [{ role: 'logo_primary', sha256: logoSha256 }] },
      profile: { name: 'strict', version: '1.0', rules: {} },
      repairCycle: 0,
    });

    expect(qaRes.ok).toBe(true);
    if (!qaRes.ok) return;
    const qaReport = qaRes.value;
    expect(qaReport.criticalPass).toBe(true);
    expect(qaReport.status).toBe('passed');
    expect(qaReport.findings.filter((f) => f.hardFailure).length).toBe(0);

    // =========================================================================
    // STEP 7: Human Operator Approval in Hawa Desk (Invariant 11)
    // =========================================================================
    sm.transition('AWAITING_APPROVAL', ctx.actor, 'Ready for desk approval');

    const approvalDecision: ApprovalDecision = {
      decisionId: crypto.randomUUID(),
      taskId,
      designRevisionId: crypto.randomUUID(),
      sourceHash: updatedDocRef.sourceSha256,
      qcReportHash: 'sha256_qc_report_verified',
      decision: 'approved',
      actor: {
        userId: crypto.randomUUID(),
        displayName: 'Senior Art Director',
        role: 'art_director',
        verifiedServerSide: true,
      },
      decidedAt: new Date().toISOString(),
    };

    const approveTransition = sm.transition('APPROVED', { type: 'user', id: approvalDecision.actor.userId }, 'Art Director approved');
    expect(approveTransition.ok).toBe(true);

    // =========================================================================
    // STEP 8: Durable Publishing to Google Drive & Google Sheets (Invariant 12)
    // =========================================================================
    sm.transition('PUBLISHING', ctx.actor, 'Publishing deliverables');

    const publishRes = await publisher.publish(ctx, {
      taskId,
      clientId,
      designRevisionId: updatedDocRef.documentId,
      approvalId: approvalDecision.decisionId,
      publicationKey: `pub_key_${taskId}`,
      packageHash: 'sha256_package_archive_hash',
      files: [
        {
          artifactId: crypto.randomUUID(),
          relativePath: 'deliverables/post.png',
          storageKey: `deliverables/${taskId}/post.png`,
          filename: 'post.png',
          mimeType: 'image/png',
          byteSize: 204800,
          sha256: 'sha256_post_png_hash',
        },
        {
          artifactId: crypto.randomUUID(),
          relativePath: 'source/post.hyc',
          storageKey: `source/${taskId}/post.hyc`,
          filename: 'post.hyc',
          mimeType: 'application/octet-stream',
          byteSize: 10240,
          sha256: updatedDocRef.sourceSha256,
        },
      ],
      destination: {
        sharedDriveId: 'drive_aster_hotel',
        productionRootFolderId: 'folder_prod_aster',
        relativeFolderParts: ['Clients', 'Aster', '2026', 'Summer'],
        spreadsheetId: 'sheet_tracker_aster',
        sheetId: 0,
      },
      sheetRow: {
        taskId,
        client: clientId,
        status: 'COMPLETE',
        publishedAt: new Date().toISOString(),
      },
    });

    expect(publishRes.ok).toBe(true);
    if (!publishRes.ok) return;
    const pubReceipt = publishRes.value;
    expect(pubReceipt.state).toBe('complete');
    expect(pubReceipt.driveFiles.length).toBe(2);
    expect(pubReceipt.sheet.synced).toBe(true);

    // Verify idempotent re-publish returns identical receipt
    const republishRes = await publisher.publish(ctx, {
      taskId,
      clientId,
      designRevisionId: updatedDocRef.documentId,
      approvalId: approvalDecision.decisionId,
      publicationKey: `pub_key_${taskId}`,
      packageHash: 'sha256_package_archive_hash',
      files: [],
      destination: {
        sharedDriveId: 'drive_aster_hotel',
        productionRootFolderId: 'folder_prod_aster',
        relativeFolderParts: [],
        spreadsheetId: 'sheet_tracker_aster',
        sheetId: 0,
      },
      sheetRow: {},
    });
    expect(republishRes.ok).toBe(true);
    if (republishRes.ok) {
      expect(republishRes.value.publicationId).toBe(pubReceipt.publicationId);
    }

    // =========================================================================
    // STEP 9: Final State Transition & Outbox Enqueue
    // =========================================================================
    sm.transition('COMPLETE', ctx.actor, 'All side-effects confirmed');
    expect(sm.getStatus()).toBe('COMPLETE');

    const outboxItem = await outboxRepo.enqueue(
      ctx.tenantId,
      taskId,
      'client:notification',
      {
        channel: 'telegram',
        chatId: normalizedMessage.source.channelId,
        text: 'دیزاینەکەت ئامادەیە لە گووگڵ درایڤ',
        publicationReceipt: pubReceipt,
      }
    );
    expect(outboxItem.id).toBeDefined();

    const leasedOutbox = await outboxRepo.leasePending(1);
    expect(leasedOutbox.length).toBe(1);
    expect(leasedOutbox[0].id).toBe(outboxItem.id);

    await outboxRepo.markDelivered(outboxItem.id);
    expect(outboxItem.state).toBe('delivered');
    expect(sm.getStatus()).toBe('COMPLETE');
  });
});
