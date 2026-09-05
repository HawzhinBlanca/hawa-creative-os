import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { RequestContext } from '@hawa/contracts';
import {
  TaskStateMachine,
  extractProtectedTokens,
  type ApprovalDecision,
} from '@hawa/domain';
import {
  BriefBuilder,
  CreativeDirectorRunner,
  DesignRouter,
} from '@hawa/creative';
import { DeterministicQAEngine } from '@hawa/qa';
import {
  HyCanvasStudioAdapter,
  GooglePublisher,
  TelegramAdapter,
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

interface ClientScenario {
  clientId: string;
  clientName: string;
  sector: string;
  palette: string[];
  logoSha256: string;
  language: 'ckb' | 'en' | 'ar';
  direction: 'rtl' | 'ltr';
  prompts: string[];
}

const SCENARIOS: ClientScenario[] = [
  {
    clientId: 'client-aster-hotel',
    clientName: 'Aster Hotel',
    sector: 'hospitality',
    palette: ['#0B0F19', '#38BDF8', '#FFFFFF'],
    logoSha256: 'sha256_aster_logo_gold',
    language: 'ckb',
    direction: 'rtl',
    prompts: [
      'داشکاندنی نوێ بۆ هۆتێل ئاستێر بۆ وەرزی هاوین نرخ ٤٥٬٠٠٠ دینار بۆ پەیوەندی 07501234567',
      'ئۆفەری خێزانی لە هۆتێل ئاستێر هەولێر بەردەستە بە بەرزترین کوالێتی',
      'شەوانی جەژن لە هۆتێل ئاستێر بە داشکاندنی ٢٠٪ بۆ هەموو ژوورەکان',
      'ڕێستورانتی هۆتێل ئاستێر: خوانێکی تایبەت لەگەڵ دیمەنی سەرنجڕاکێش',
    ],
  },
  {
    clientId: 'client-nova-tech',
    clientName: 'Nova Tech Solutions',
    sector: 'technology',
    palette: ['#0F172A', '#6366F1', '#F8FAFC'],
    logoSha256: 'sha256_nova_tech_vector_logo',
    language: 'en',
    direction: 'ltr',
    prompts: [
      'Nova Cloud Enterprise: Secure Hybrid Infrastructure for Modern Teams at $49/mo call +9647509876543',
      'Launch your next-gen SaaS in minutes with Nova Microservices Stack',
      'Nova Cyber Defense 2026: Zero Trust Architecture for Financial Institutions',
      'Scalable AI compute on Nova Private GPU Cluster starting from $199',
    ],
  },
  {
    clientId: 'client-drustee-dairy',
    clientName: 'Drustee Dairy',
    sector: 'fmcg',
    palette: ['#064E3B', '#10B981', '#FFFFFF'],
    logoSha256: 'sha256_drustee_green_seal',
    language: 'ckb',
    direction: 'rtl',
    prompts: [
      'شیر و بەرهەمە نوێکانی دروستی لە تەواوی مارکێتەکانی کوردستان بەردەستە نرخ ٢٬٥٠٠ دینار',
      'ماستی تەندروست و سروشتی دروستی بەبێ هیچ ماددەیەکی کیمیایی',
      'پەنیر و کەرەی کوردی دروستی، تامێکی ڕەسەن بۆ سەر خوانەکانتان',
      'داشکاندنی کۆگا لەسەر تەواوی شیری دروستی لە سەرانسەری هەولێر و سلێمانی',
    ],
  },
];

describe('Pilot Exit Acceptance Gate: 100-Production Task Lifecycle Simulation Drill (Pilot Exit, NFR-001, NFR-005, Invariants #1–#15)', () => {
  const secretKey = 'sec_office_token_pilot_drill';

  it('executes 100 concurrent end-to-end production tasks with >=95% completion, 0 flattened raster layers, and 0 cross-tenant leaks', async () => {
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
    const designRouter = new DesignRouter();

    const TOTAL_TASKS = 100;
    const taskResults: Array<{
      taskIndex: number;
      taskId: string;
      clientId: string;
      completed: boolean;
      flattenedRasterLayers: number;
      crossTenantContamination: boolean;
      qaPassed: boolean;
      executionTimeMs: number;
      error?: string;
    }> = [];

    const startTime = Date.now();

    // Generate 100 task descriptors distributed across the 3 clients
    const taskDescriptors = Array.from({ length: TOTAL_TASKS }, (_, i) => {
      const scenario = SCENARIOS[i % SCENARIOS.length];
      const prompt = scenario.prompts[Math.floor(i / SCENARIOS.length) % scenario.prompts.length];
      return {
        index: i + 1,
        scenario,
        prompt: `${prompt} [Batch-${Math.floor(i / 10) + 1}-#${i + 1}]`,
      };
    });

    // Execute in parallel batches of 20 tasks to simulate heavy concurrent office workload
    const BATCH_SIZE = 20;
    for (let batchStart = 0; batchStart < TOTAL_TASKS; batchStart += BATCH_SIZE) {
      const batch = taskDescriptors.slice(batchStart, batchStart + BATCH_SIZE);

      await Promise.all(
        batch.map(async ({ index, scenario, prompt }) => {
          const tStart = Date.now();
          const taskId = crypto.randomUUID();
          const correlationId = `corr-pilot-${index}-${Date.now()}`;
          const ctx: RequestContext = {
            tenantId: 'tenant-pilot-exit',
            actor: { type: 'workflow', id: `wf-pilot-runner-${index}` },
            correlationId,
            deadline: new Date(Date.now() + 60000).toISOString(),
            idempotencyKey: `idem-pilot-${index}`,
          };

          try {
            // 1. Ingress Adapter (Telegram / WhatsApp non-authoritative ingress)
            const tgPayload = {
              update_id: 90000 + index,
              message: {
                message_id: 1000 + index,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 70000 + index },
                from: { id: 8000 + index, first_name: 'Client Representative' },
                text: prompt,
              },
            };

            const recordedIngress = await ingressRepo.recordEvent({
              adapterKind: 'telegram',
              sourceEventId: `msg_${index}`,
              payloadHash: crypto.createHash('sha256').update(JSON.stringify(tgPayload)).digest('hex'),
              headers: { 'x-telegram-bot-api-secret-token': secretKey },
              body: tgPayload,
              verified: true,
            });
            expect(recordedIngress.isDuplicate).toBe(false);

            // 2. Task Creation & Client Scope Locking (Invariant #4)
            const taskCreation = await taskRepo.create({
              tenantId: ctx.tenantId,
              clientId: scenario.clientId,
              sourcePlatform: 'telegram',
              sourceEventId: `msg_${index}`,
              sourceChannelId: String(tgPayload.message.chat.id),
              idempotencyKey: ctx.idempotencyKey,
              priority: 'routine',
            });
            const dbTaskId = taskCreation.task.id;

            const lockedTask = await taskRepo.lockClientScope(dbTaskId, scenario.clientId);
            expect(lockedTask.client_scope_locked).toBe(true);

            const sm = new TaskStateMachine(dbTaskId, 'RECEIVED');
            sm.transition('ROUTING', ctx.actor, 'Design routing initiated');

            // 3. Pre-Retrieval Scoped Isolation (Invariant #4 & Invariant #6)
            const clientCtx = { ...ctx, clientId: scenario.clientId };
            const retrievalRes = await retrievalService.retrieve(clientCtx, [
              { query: prompt, kinds: ['rule', 'official_asset', 'client_dna'], topK: 5 },
            ]);
            expect(retrievalRes.ok).toBe(true);

            // Assert zero cross-tenant contamination
            let crossTenantContamination = false;
            if (retrievalRes.ok) {
              const foreignAssets = retrievalRes.value.evidence.filter(
                (e) => e.clientId && e.clientId !== scenario.clientId
              );
              if (foreignAssets.length > 0) {
                crossTenantContamination = true;
              }
            }

            // 4. Brief Synthesis & Protected Token Extraction (Invariant #5)
            const briefRes = briefBuilder.build({
              taskId: dbTaskId,
              clientId: scenario.clientId,
              clientDnaVersion: 1,
              objective: `${scenario.clientName} Campaign #${index}`,
              rawRequestText: prompt,
            });
            expect(briefRes.ok).toBe(true);
            if (!briefRes.ok) throw new Error('Brief build failed');
            const brief = briefRes.value;

            // Route resolution based on synthesized brief
            const routeResult = designRouter.resolveRoute(brief, [
              { id: 'tpl_holiday_sale', category: scenario.sector, matchScore: 0.85 },
            ]);
            expect(routeResult.route).toBeDefined();

            sm.transition('BRIEFING', ctx.actor, `Client scope locked to ${scenario.clientId}`);

            const protectedTokens = extractProtectedTokens(prompt);
            expect(protectedTokens).toBeDefined();

            sm.transition('PLANNING', ctx.actor, 'Planning studio layout');

            // 6. Creative Direction Plan & HyCanvas Structured Operations (Invariant #1, #2, #3)
            const designPlan = creativeDirector.createDesignPlan(brief, scenario.palette);
            expect(designPlan.zones.length).toBeGreaterThan(0);
            expect(designPlan.artDirectionReference.shippedInArtifact).toBe(false);

            sm.transition('COMPOSING', ctx.actor, 'Composing structured layers');

            const createDocRes = await studio.create(ctx, {
              name: `${scenario.clientName} - Task ${index}`,
              pages: brief.variants.map((v) => ({
                id: v.id,
                name: v.name,
                width: v.width,
                height: v.height,
                unit: 'px',
                language: scenario.language,
                direction: scenario.direction,
              })),
              clientDnaVersion: 1,
            });
            expect(createDocRes.ok).toBe(true);
            if (!createDocRes.ok) throw new Error('Studio document create failed');
            const initialDoc = createDocRes.value;

            // Generate discrete editable nodes (text, vector buttons, logo asset)
            const ops = creativeDirector.generateStudioOperations(brief, designPlan, scenario.logoSha256);
            expect(ops.length).toBeGreaterThan(0);

            const applyRes = await studio.apply(ctx, {
              document: initialDoc,
              expectedSourceSha256: initialDoc.sourceSha256,
              operationBatchId: `batch_${index}`,
              operations: ops,
              destructiveOperationsAllowed: false,
            });
            expect(applyRes.ok).toBe(true);
            if (!applyRes.ok) throw new Error('Studio apply failed');
            const composedDoc = applyRes.value;

            // Verify Invariant #1: ZERO flattened raster layers containing text
            const manifestRes = await studio.getManifest(ctx, composedDoc);
            expect(manifestRes.ok).toBe(true);
            if (!manifestRes.ok) throw new Error('Manifest get failed');
            const manifest = manifestRes.value;

            // Inspect every node: text nodes must have text and fontSize, never baked raster images
            let flattenedRasterLayers = 0;
            for (const node of manifest.nodes) {
              if (node.type === 'image' && node.role === 'headline') {
                flattenedRasterLayers++;
              }
              if (node.type === 'text') {
                expect(node.text).toBeDefined();
                expect(node.text!.length).toBeGreaterThan(0);
              }
            }

            // 7. Deterministic QA Engine Evaluation (Gate E, Invariant #7)
            sm.transition('QA', ctx.actor, 'Running deterministic QA');
            const qaRes = await qaEngine.run(ctx, {
              taskId: dbTaskId,
              designRevisionId: crypto.randomUUID(),
              document: composedDoc,
              sourceHash: composedDoc.sourceSha256,
              manifest,
              renders: [],
              brief: brief as any,
              clientDna: { assets: [{ role: 'logo_primary', sha256: scenario.logoSha256 }] },
              profile: { name: 'strict', version: '1.0', rules: {} },
              repairCycle: 0,
            });
            expect(qaRes.ok).toBe(true);
            if (!qaRes.ok) throw new Error('QA run failed');
            const qaReport = qaRes.value;
            expect(qaReport.status).toBe('passed');
            expect(qaReport.criticalPass).toBe(true);

            // 8. Human Review Decision Gate (Gate F, Invariant #11)
            sm.transition('AWAITING_APPROVAL', ctx.actor, 'Awaiting human sign-off');
            const approvalDecision: ApprovalDecision = {
              decisionId: crypto.randomUUID(),
              taskId: dbTaskId,
              designRevisionId: composedDoc.documentId,
              sourceHash: composedDoc.sourceSha256,
              qcReportHash: 'sha256_qc_pilot_pass',
              decision: 'approved',
              actor: {
                userId: `art_director_${index % 3}`,
                displayName: 'Lead Art Director',
                role: 'art_director',
                verifiedServerSide: true,
              },
              decidedAt: new Date().toISOString(),
            };

            const approveTrans = sm.transition('APPROVED', { type: 'user', id: approvalDecision.actor.userId }, 'Approved in drill');
            expect(approveTrans.ok).toBe(true);

            // 9. Durable Omnichannel Publication (Gate G, Invariant #12)
            sm.transition('PUBLISHING', ctx.actor, 'Publishing to production storage');
            const publishRes = await publisher.publish(ctx, {
              taskId: dbTaskId,
              clientId: scenario.clientId,
              designRevisionId: composedDoc.documentId,
              approvalId: approvalDecision.decisionId,
              publicationKey: `pub_drill_${dbTaskId}`,
              packageHash: `sha256_pkg_${index}`,
              files: [
                {
                  artifactId: crypto.randomUUID(),
                  relativePath: 'deliverables/feed.png',
                  storageKey: `deliverables/${dbTaskId}/feed.png`,
                  filename: `${scenario.clientId}-feed.png`,
                  mimeType: 'image/png',
                  byteSize: 350000,
                  sha256: `sha256_feed_${index}`,
                },
                {
                  artifactId: crypto.randomUUID(),
                  relativePath: 'deliverables/vector.svg',
                  storageKey: `deliverables/${dbTaskId}/vector.svg`,
                  filename: `${scenario.clientId}-vector.svg`,
                  mimeType: 'image/svg+xml',
                  byteSize: 45000,
                  sha256: `sha256_svg_${index}`,
                },
                {
                  artifactId: crypto.randomUUID(),
                  relativePath: 'source/editable_tree.hyc',
                  storageKey: `source/${dbTaskId}/editable_tree.hyc`,
                  filename: `${scenario.clientId}.hyc`,
                  mimeType: 'application/json',
                  byteSize: 18000,
                  sha256: composedDoc.sourceSha256,
                },
              ],
              destination: {
                sharedDriveId: `drive_${scenario.clientId}`,
                productionRootFolderId: `folder_${scenario.clientId}`,
                relativeFolderParts: ['Clients', scenario.clientName, '2026'],
                spreadsheetId: `sheet_${scenario.clientId}`,
                sheetId: 0,
              },
              sheetRow: {
                taskId: dbTaskId,
                client: scenario.clientId,
                status: 'COMPLETE',
                publishedAt: new Date().toISOString(),
              },
            });

            expect(publishRes.ok).toBe(true);
            if (!publishRes.ok) throw new Error('Publisher failed');
            const receipt = publishRes.value;
            expect(receipt.state).toBe('complete');
            expect(receipt.driveFiles.length).toBe(3);
            expect(receipt.sheet.synced).toBe(true);

            // 10. Complete Task & Enqueue Delivery Notification
            sm.transition('COMPLETE', ctx.actor, 'Task completed');
            expect(sm.getStatus()).toBe('COMPLETE');

            await outboxRepo.enqueue(ctx.tenantId, dbTaskId, 'client:delivered', {
              channel: 'telegram',
              receiptId: receipt.publicationId,
            });

            taskResults.push({
              taskIndex: index,
              taskId: dbTaskId,
              clientId: scenario.clientId,
              completed: true,
              flattenedRasterLayers,
              crossTenantContamination,
              qaPassed: qaReport.status === 'passed',
              executionTimeMs: Date.now() - tStart,
            });
          } catch (err: any) {
            taskResults.push({
              taskIndex: index,
              taskId,
              clientId: scenario.clientId,
              completed: false,
              flattenedRasterLayers: 0,
              crossTenantContamination: false,
              qaPassed: false,
              executionTimeMs: Date.now() - tStart,
              error: err.message,
            });
          }
        })
      );
    }

    const totalDurationMs = Date.now() - startTime;

    // =========================================================================
    // PILOT EXIT ACCEPTANCE CRITERIA EVALUATION
    // =========================================================================
    const completedTasks = taskResults.filter((t) => t.completed);
    const failedTasks = taskResults.filter((t) => !t.completed);
    const completionRate = (completedTasks.length / TOTAL_TASKS) * 100;
    const totalFlattenedRasterLayers = taskResults.reduce((sum, t) => sum + t.flattenedRasterLayers, 0);
    const totalCrossTenantLeaks = taskResults.filter((t) => t.crossTenantContamination).length;
    const allQAPassed = taskResults.every((t) => t.qaPassed);

    console.log(`\n======================================================`);
    console.log(`PILOT EXIT 100-TASK SIMULATION DRILL SCORECARD`);
    console.log(`======================================================`);
    console.log(`Total Tasks Simulated:          ${TOTAL_TASKS}`);
    console.log(`Completed Tasks:                ${completedTasks.length}/${TOTAL_TASKS} (${completionRate}%)`);
    console.log(`Failed Tasks:                   ${failedTasks.length}`);
    if (failedTasks.length > 0) {
      console.log(`First Failed Task Error:        ${failedTasks[0].error}`);
    }
    console.log(`Flattened Raster Layers:        ${totalFlattenedRasterLayers} (Target: 0)`);
    console.log(`Cross-Tenant Contamination:     ${totalCrossTenantLeaks} (Target: 0)`);
    console.log(`Deterministic QA 100% Pass:     ${allQAPassed}`);
    console.log(`Total Wall-Clock Time:          ${totalDurationMs} ms`);
    console.log(`Average Latency per Task:       ${(totalDurationMs / TOTAL_TASKS).toFixed(2)} ms`);
    console.log(`======================================================\n`);

    // Gate Assertions
    expect(completedTasks.length).toBe(TOTAL_TASKS);
    expect(completionRate).toBeGreaterThanOrEqual(95); // NFR-001 threshold >= 95%, achieved 100%
    expect(totalFlattenedRasterLayers).toBe(0); // Invariant #1: All designs live vector trees
    expect(totalCrossTenantLeaks).toBe(0); // Invariant #6: Zero cross-tenant leaks
    expect(allQAPassed).toBe(true); // Gate E: Deterministic QA 100%
    expect(store.outbox.length).toBe(TOTAL_TASKS); // Invariant #13: Transactional outbox
  }, 120000);
});
