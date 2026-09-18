import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { DesignStudioService, isPipelineV3Run } from '../src/services/design-studio/design-studio-service.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { CanvaDesignPlanner } from '../src/services/canva-design-planner.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import type { StudioLayoutV2 } from '@hawa/creative';

const url = process.env.HAWA_ISOLATED_TEST_DB;

describe.skipIf(!url)('DesignStudioService Orchestrator (T11)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';

  const mockLayout: StudioLayoutV2 = {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    art: {
      source: 'procedural',
      motif: 'thin-rules',
      box: { x: 0, y: 0, width: 1080, height: 1350 },
      opacity: 0.15,
      calmRegion: { x: 86, y: 245, width: 908, height: 1000 },
    },
    shapes: [
      {
        x: 86,
        y: 245,
        width: 908,
        height: 2,
        kind: 'rect',
        color: '#F7B500',
        role: 'rule',
      },
    ],
    text: [
      {
        // One line of 48px type at 1.2 needs 58px; a shorter box fails QA's COPY_OVERFLOW.
        x: 86,
        y: 260,
        width: 908,
        height: 60,
        copyIndex: 0,
        role: 'title',
        fontSize: 48,
        lineHeight: 1.2,
        fontFamily: 'Verdana',
        color: '#FFFFFF',
        align: 'center',
        bold: true,
      },
      {
        x: 86,
        y: 350,
        width: 908,
        height: 80,
        copyIndex: 1,
        role: 'body',
        fontSize: 20,
        lineHeight: 1.4,
        fontFamily: 'Verdana',
        color: '#FDF8F3',
        align: 'center',
      },
    ],
    logo: {
      x: 490,
      y: 86,
      width: 100,
      height: 100,
    },
  };

  const createMockFetch = (overrides: Record<string, any> = {}) => {
    return vi.fn().mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body || '{}');
      const promptText = (
        Array.isArray(body.messages)
          ? body.messages.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join(' ')
          : ''
      ) + ' ' + JSON.stringify(body.system || '') + ' ' + (body.prompt || '');

      let resultData: any = {};

      if (promptText.includes('CreativeBrief') || promptText.includes('turn the saved request into a creative brief')) {
        resultData = {
          occasion: '10th Anniversary Gala',
          audience: 'Alumni and donors',
          formality: 5,
          toneWords: ['Monumental', 'Prestigious', 'Celebratory'],
          readingOrder: [0, 1],
          roles: [
            { copyIndex: 0, role: 'title', importance: 5 },
            { copyIndex: 1, role: 'body', importance: 3 },
          ],
          must: ['Honor 10-year milestone'],
          mustNot: ['No clip art'],
          imageryStrategy: 'none',
          imageryRationale: 'Typography only',
          kurdishLeads: false,
          riskFlags: [],
        };
      } else if (promptText.includes('ConceptBoard') || promptText.includes('genuinely different concepts')) {
        resultData = {
          concepts: [
            {
              id: 'c1',
              name: 'Editorial Classic',
              archetype: 'editorial-centered',
              artStrategy: 'none',
              typographicScale: { ratio: 1.4, titleSize: 48, bodySize: 20 },
              colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#4770A3' },
              layoutIdea: 'Centered authority',
              whyDifferent: 'Pure editorial balance',
            },
            {
              id: 'c2',
              name: 'Framed Monument',
              archetype: 'framed-invitation',
              artStrategy: 'none',
              typographicScale: { ratio: 1.4, titleSize: 48, bodySize: 20 },
              colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#4770A3' },
              layoutIdea: 'Outer rules with inner title',
              whyDifferent: 'Border framing',
            },
            {
              id: 'c3',
              name: 'Monumental Title',
              archetype: 'monumental-title',
              artStrategy: 'none',
              typographicScale: { ratio: 1.4, titleSize: 48, bodySize: 20 },
              colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#4770A3' },
              layoutIdea: 'Giant headline focus',
              whyDifferent: 'Scale contrast',
            },
          ],
        };
      } else if (promptText.includes('StudioLayoutV2') || promptText.includes('produce the complete layout')) {
        resultData = { layout: mockLayout, notes: 'Centered classical hierarchy' };
      } else if (promptText.includes('CandidateCritique') || promptText.includes('evaluate candidate')) {
        resultData = {
          observations: [
            { text: 'Clear hierarchy', region: { x: 86, y: 260, w: 908, h: 35 } },
            { text: 'Legible body', region: { x: 86, y: 350, w: 908, h: 80 } },
            { text: 'Brand colors', region: { x: 0, y: 0, w: 1080, h: 1350 } },
            { text: 'Sufficient contrast', region: { x: 86, y: 260, w: 908, h: 35 } },
            { text: 'Safe margins respected', region: { x: 0, y: 0, w: 86, h: 1350 } },
          ],
          scores: {
            hierarchy: 9.0,
            typography: 8.8,
            composition: 8.9,
            whitespace: 8.5,
            brandFidelity: 9.5,
            legibility: 9.0,
            craft: 8.7,
          },
          evidence: {
            hierarchy: 'Title clearly dominates body copy',
            typography: 'Verdana rendered crisply',
            composition: 'Centered column with balanced margins',
            whitespace: '55% calm breathing room',
            brandFidelity: 'Official KAAE Midnight Navy and Gold',
            legibility: 'High APCA contrast on all blocks',
            craft: 'Clean lines and exact logo placement',
          },
          hardFails: [],
          revisions: [],
          overall: 8.9,
        };
      } else if (promptText.includes('PairwiseVerdict') || promptText.includes('choose between candidate A and candidate B')) {
        resultData = {
          winner: 'A',
          confidence: 0.9,
          reasons: ['Candidate A has stronger margins and clearer hierarchy.'],
          hardFails: { A: [], B: [] },
        };
      } else if (promptText.includes('CanaryVerdict') || promptText.includes('verify judge reliability')) {
        resultData = {
          passed: true,
          defectDetected: false,
          confidence: 0.95,
          notes: 'Candidate passes canary criteria.',
        };
      } else {
        resultData = overrides.defaultResult || { layout: mockLayout };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `msg_${randomUUID().slice(0, 8)}`,
          model: 'gpt-6-astra',
          stop_reason: 'end_turn',
          choices: [
            {
              message: {
                content: JSON.stringify(resultData),
              },
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 300, input_tokens: 500, output_tokens: 300 },
          content: [{ type: 'text', text: JSON.stringify(resultData) }],
        }),
      };
    });
  };

  const scope = {
    tenantId: '00000000-0000-4000-a000-000000000001',
    actorId: '00000000-0000-4000-b000-000000000001',
  };

  const createTask = async (
    rawText = 'Keep title centered.\n---\nEXACT TITLE\n\nExact body text line. Never rewrite it.',
    sourceChannelId = `isolated-test-${randomUUID().slice(0, 8)}`
  ) => {
    const intake = await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId,
      clientId,
      title: '[TEST] Studio Task',
      rawText,
      designInstructions: 'Keep title centered.',
      exactCopy: [],
    });
    return intake.task.id;
  };

  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id, email, display_name) 
      VALUES(${scope.actorId}::uuid, 'isolated-operator@example.test', 'Test') 
      ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id, tenant_id, code, name) 
      VALUES(${clientId}::uuid, ${scope.tenantId}::uuid, 'kaae', 'KAAE') 
      ON CONFLICT DO NOTHING`.execute(db);
  });

  beforeEach(async () => {
    await withRlsContext(db, scope, async (tx) => {
      await sql`UPDATE hawa.design_studio_runs 
        SET status='abandoned' 
        WHERE tenant_id=${scope.tenantId}::uuid 
          AND status NOT IN ('transferred','degraded','failed','abandoned')`.execute(tx);
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('1. repeated Idempotency-Key returns the same run; altered payload throws GENERATION_CONFLICT', async () => {
    const taskId = await createTask();
    const fetcher = createMockFetch();
    const service = new DesignStudioService(db, undefined, {
      apiKey: 'test-key',
      fetcher,
      defaultTier: 'standard',
    });

    const key = `key-${randomUUID().slice(0, 16)}`;
    const res1 = await service.createOrGetRun(scope, taskId, key, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    expect(res1.created).toBe(true);
    expect(res1.run.id).toBeDefined();
    expect(res1.run.status).toBe('briefing');

    // Repeated call with same key and same payload returns same run
    const res2 = await service.createOrGetRun(scope, taskId, key, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    expect(res2.created).toBe(false);
    expect(res2.run.id).toBe(res1.run.id);

    // Call with same key but altered payload throws 409 GENERATION_CONFLICT
    await expect(
      service.createOrGetRun(scope, taskId, key, {
        width: 1200, // altered width
        height: 1350,
        tier: 'standard',
      })
    ).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });
  });

  it('2. enforces one active run per task and 2 active runs per tenant', async () => {
    const taskId1 = await createTask();
    const taskId2 = await createTask();
    const taskId3 = await createTask();

    const fetcher = createMockFetch();
    const service = new DesignStudioService(db, undefined, {
      apiKey: 'test-key',
      fetcher,
      defaultTier: 'standard',
    });

    // 1st active run
    const run1 = await service.createOrGetRun(scope, taskId1, `key-${randomUUID().slice(0, 16)}`, {
      width: 1080,
      height: 1350,
    });
    expect(run1.created).toBe(true);

    // Attempt 2nd run on same task -> throws STUDIO_RUN_IN_PROGRESS
    await expect(
      service.createOrGetRun(scope, taskId1, `key-${randomUUID().slice(0, 16)}`, {
        width: 1080,
        height: 1350,
      })
    ).rejects.toMatchObject({ code: 'STUDIO_RUN_IN_PROGRESS' });

    // 2nd active run on different task -> succeeds
    const run2 = await service.createOrGetRun(scope, taskId2, `key-${randomUUID().slice(0, 16)}`, {
      width: 1080,
      height: 1350,
    });
    expect(run2.created).toBe(true);

    // 3rd active run on tenant -> throws 429 STUDIO_BUSY
    await expect(
      service.createOrGetRun(scope, taskId3, `key-${randomUUID().slice(0, 16)}`, {
        width: 1080,
        height: 1350,
      })
    ).rejects.toMatchObject({ code: 'STUDIO_BUSY' });
  });

  it('3. interruption between stages resumes without a second charge (ledger count unchanged)', async () => {
    const taskId = await createTask();
    const fetcher = createMockFetch();
    const service = new DesignStudioService(db, undefined, {
      apiKey: 'test-key',
      fetcher,
      defaultTier: 'standard',
    });

    const key = `key-${randomUUID().slice(0, 16)}`;
    const { run } = await service.createOrGetRun(scope, taskId, key, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    // Stage 1: Briefing -> Conceiving
    const step1 = await service.resume(scope, taskId, run.id);
    expect(step1.status).toBe('conceiving');
    expect(step1.stage).toBe('brief');

    // Verify ledger has exactly 1 call recorded for stage 'briefing'
    const callsAfterBrief = (
      await sql<any>`SELECT count(*) as n FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid AND stage='briefing'`.execute(db)
    ).rows[0];
    expect(Number(callsAfterBrief.n)).toBe(1);

    // Stage 2: Conceiving -> Laying out
    const step2 = await service.resume(scope, taskId, run.id);
    expect(step2.status).toBe('laying_out');
    expect(step2.stage).toBe('concepts');

    // Simulate interruption: retrieve run again and verify previous calls remain intact without duplicate charges
    const briefCallsCheck = (
      await sql<any>`SELECT count(*) as n FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid AND stage='briefing'`.execute(db)
    ).rows[0];
    expect(Number(briefCallsCheck.n)).toBe(1); // Brief was NOT called again

    const conceptCallsCheck = (
      await sql<any>`SELECT count(*) as n FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid AND stage='conceiving'`.execute(db)
    ).rows[0];
    expect(Number(conceptCallsCheck.n)).toBe(1);
  });

  it('4. budget cap exhaustion transitions to BUDGET_EXHAUSTED with best candidate so far', async () => {
    const taskId = await createTask();
    const fetcher = createMockFetch();

    // Configure service with strict budget: maxUsd = 0.0001 (will breach after brief)
    const service = new DesignStudioService(db, undefined, {
      apiKey: 'test-key',
      fetcher,
      maxUsd: 0.0001,
      defaultTier: 'standard',
    });

    const key = `key-${randomUUID().slice(0, 16)}`;
    const { run } = await service.createOrGetRun(scope, taskId, key, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    // Step 1: brief executes and records cost (> 0.0001)
    await service.resume(scope, taskId, run.id);

    // Step 2: next stage attempts model call, detects budget breach -> handles exhaustion
    const result = await service.resume(scope, taskId, run.id);
    expect(result.diagnostic).toContain('BUDGET_EXHAUSTED');
  });

  it('5. degradation ladder Rung 4 fallback calls the planner when studio stages fail unrecoverably', async () => {
    const taskId = await createTask();
    const baseFetch = createMockFetch();

    // Create fetcher that fails when layout stage is called
    const failFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      const body = JSON.parse(init.body || '{}');
      const promptText = (
        Array.isArray(body.messages)
          ? body.messages.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join(' ')
          : ''
      ) + ' ' + JSON.stringify(body.system || '') + ' ' + (body.prompt || '');

      if (promptText.includes('StudioLayoutV2') || promptText.includes('produce the complete layout')) {
        throw new Error('Fatal layout model outage');
      }

      return baseFetch(url, init);
    });

    const fallbackPlanId = randomUUID();
    const planBytes = Buffer.from('fallback-plan-content');
    const planSha = createHash('sha256').update(planBytes).digest('hex');

    const mockPlanner = {
      generate: vi.fn().mockImplementation(async () => {
        await sql`INSERT INTO hawa.canva_design_plans(
          id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status, result, source_content, source_sha256
        ) VALUES(
          ${fallbackPlanId}::uuid, ${scope.tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${scope.actorId},
          ${'plan-' + fallbackPlanId}, 'reqhash', '{}'::jsonb, 'planned', '{}'::jsonb, ${planBytes}, ${planSha}
        )`.execute(db);
        return { planId: fallbackPlanId, status: 'planned', message: 'Fallback plan created' };
      }),
    } as unknown as CanvaDesignPlanner;

    const service = new DesignStudioService(db, undefined, {
      apiKey: 'test-key',
      fetcher: failFetch,
      planner: mockPlanner,
      defaultTier: 'standard',
      maxRetries: 0,
    });

    const key = `key-${randomUUID().slice(0, 16)}`;
    const { run } = await service.createOrGetRun(scope, taskId, key, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    // Advance to conceiving
    await service.resume(scope, taskId, run.id);
    // Advance to laying_out
    await service.resume(scope, taskId, run.id);
    // Laying_out fails -> triggers Rung 4 fallback
    const step = await service.resume(scope, taskId, run.id);

    expect(step.status).toBe('degraded');
    expect(step.message).toContain('Rung 4 studio fallback');
    expect(mockPlanner.generate).toHaveBeenCalledTimes(1);
  }, 25000);

  it('5b. when DESIGN_PIPELINE_V3=on, studio stage failure marks run as failed and NEVER calls single-shot planner fallback', async () => {
    const originalEnv = process.env.DESIGN_PIPELINE_V3;
    process.env.DESIGN_PIPELINE_V3 = 'on';

    try {
      const taskId = await createTask();

      const baseFetch = createMockFetch();
      const failFetch = vi.fn().mockImplementation(async (url: any, init: any) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        const promptText = (
          Array.isArray(body.messages)
            ? body.messages.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join(' ')
            : ''
        ) + ' ' + JSON.stringify(body.system || '') + ' ' + (body.prompt || '');

        if (promptText.includes('StudioLayoutV2') || promptText.includes('produce the complete layout') || promptText.includes('Art Director')) {
          throw new Error('Fatal layout model outage');
        }

        return baseFetch(url, init);
      });

      const mockPlanner = {
        generate: vi.fn(),
      } as unknown as CanvaDesignPlanner;

      const service = new DesignStudioService(db, undefined, {
        apiKey: 'test-key',
        fetcher: failFetch,
        planner: mockPlanner,
        defaultTier: 'standard',
        maxRetries: 0,
      });

      const key = `key-${randomUUID().slice(0, 16)}`;
      const { run } = await service.createOrGetRun(scope, taskId, key, {
        width: 1080,
        height: 1350,
        tier: 'standard',
      });

      // Advance to conceiving
      await service.resume(scope, taskId, run.id);
      // Advance to laying_out
      await service.resume(scope, taskId, run.id);
      // Laying_out fails -> must NOT call single-shot planner
      const step = await service.resume(scope, taskId, run.id);

      expect(step.status).toBe('failed');
      expect(step.diagnostic).toContain('Studio v3 failed');
      expect(mockPlanner.generate).not.toHaveBeenCalled();
    } finally {
      process.env.DESIGN_PIPELINE_V3 = originalEnv;
    }
  }, 25000);

  it('5c. a pilot chat runs v3 while the global flag is off; a chat off the list does not', async () => {
    const originalFlag = process.env.DESIGN_PIPELINE_V3;
    const originalChats = process.env.DESIGN_PIPELINE_V3_CHATS;
    const pilotChat = `isolated-pilot-${randomUUID().slice(0, 8)}`;
    process.env.DESIGN_PIPELINE_V3 = 'off';
    process.env.DESIGN_PIPELINE_V3_CHATS = ` other-chat , ${pilotChat} `;

    try {
      const pilotTaskId = await createTask(undefined, pilotChat);
      const otherTaskId = await createTask();

      const service = new DesignStudioService(db, undefined, {
        apiKey: 'test-key',
        fetcher: createMockFetch(),
        planner: { generate: vi.fn() } as unknown as CanvaDesignPlanner,
        defaultTier: 'standard',
        maxRetries: 0,
      });

      const pilot = await service.createOrGetRun(scope, pilotTaskId, `key-${randomUUID().slice(0, 16)}`, {
        width: 1080,
        height: 1350,
        tier: 'standard',
      });
      const pilotRequest =
        typeof pilot.run.request === 'string' ? JSON.parse(pilot.run.request) : pilot.run.request;
      expect(pilotRequest.pipelineV3).toBe(true);
      expect(isPipelineV3Run(pilot.run)).toBe(true);

      const other = await service.createOrGetRun(scope, otherTaskId, `key-${randomUUID().slice(0, 16)}`, {
        width: 1080,
        height: 1350,
        tier: 'standard',
      });
      const otherRequest =
        typeof other.run.request === 'string' ? JSON.parse(other.run.request) : other.run.request;
      expect(otherRequest.pipelineV3).toBeUndefined();
      expect(isPipelineV3Run(other.run)).toBe(false);

      // The decision is the run's, not the environment's: clearing the list afterwards does not
      // move a pilot run off v3 halfway through.
      process.env.DESIGN_PIPELINE_V3_CHATS = '';
      expect(isPipelineV3Run(pilot.run)).toBe(true);
    } finally {
      if (originalFlag === undefined) delete process.env.DESIGN_PIPELINE_V3;
      else process.env.DESIGN_PIPELINE_V3 = originalFlag;
      if (originalChats === undefined) delete process.env.DESIGN_PIPELINE_V3_CHATS;
      else process.env.DESIGN_PIPELINE_V3_CHATS = originalChats;
    }
  }, 25000);

  it('6. advances full pipeline to transferred status and creates canva_design_plans row', async () => {
    const taskId = await createTask();
    const fetcher = createMockFetch();

    const mockCanvaService = {
      importEditableDesign: vi.fn().mockResolvedValue({
        operationId: randomUUID(),
        status: 'submitted',
        designId: 'DAF12345678',
      }),
    } as unknown as CanvaConnectService;

    const service = new DesignStudioService(db, mockCanvaService, {
      apiKey: 'test-key',
      fetcher,
      defaultTier: 'standard',
    });

    const key = `key-${randomUUID().slice(0, 16)}`;
    const { run } = await service.createOrGetRun(scope, taskId, key, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    // Step through each stage until transferred
    let currentStatus = run.status;
    let iterations = 0;
    while (!['transferred', 'failed', 'degraded'].includes(currentStatus) && iterations < 15) {
      const step = await service.resume(scope, taskId, run.id);
      currentStatus = step.status;
      iterations++;
    }

    expect(currentStatus).toBe('transferred');

    // Verify row was created in hawa.canva_design_plans
    const planRow = (
      await sql<any>`SELECT * FROM hawa.canva_design_plans WHERE task_id=${taskId}::uuid AND status='planned'`.execute(db)
    ).rows[0];

    expect(planRow).toBeDefined();
    expect(planRow.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(planRow.source_content).toBeDefined();
    expect(mockCanvaService.importEditableDesign).toHaveBeenCalledTimes(1);
  }, 30000);

  it('6b. a pilot chat\'s run goes through the shared v3 stages, records every judgement, and transfers', async () => {
    const originalFlag = process.env.DESIGN_PIPELINE_V3;
    const originalChats = process.env.DESIGN_PIPELINE_V3_CHATS;
    const pilotChat = `isolated-pilot-${randomUUID().slice(0, 8)}`;
    process.env.DESIGN_PIPELINE_V3 = 'off';
    process.env.DESIGN_PIPELINE_V3_CHATS = pilotChat;

    // Three distinct archetypes in the generator's normalised form (from its own tests).
    const v3Layouts = [
      {
        id: 'c1', conceptTitle: 'Monolith Centered', compositionArchetype: 'monolith_centered',
        typeScale: { base: 14, ratio: 1.25 }, grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
        background: { color: '#0A1628' }, logo: { x: 0.407, y: 0.059, width: 0.185, height: 0.074 }, art: null, shapes: [],
        text: [
          { copyIndex: 0, role: 'title', x: 0.074, y: 0.16, width: 0.852, height: 0.09, fontSize: 0.031, lineHeight: 1.3, letterSpacing: null, fontFamily: 'Cinzel', color: '#C5A059', align: 'center', bold: true, italic: false, rtl: false },
          { copyIndex: 1, role: 'body', x: 0.092, y: 0.40, width: 0.816, height: 0.18, fontSize: 0.013, lineHeight: 1.5, letterSpacing: null, fontFamily: 'Verdana', color: '#FDF8F3', align: 'center', bold: false, italic: false, rtl: false },
        ],
      },
      {
        id: 'c2', conceptTitle: 'Asymmetric Editorial', compositionArchetype: 'asymmetric_editorial',
        typeScale: { base: 16, ratio: 1.333 }, grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
        background: { color: '#0C2340' }, logo: { x: 0.074, y: 0.059, width: 0.185, height: 0.074 }, art: null,
        shapes: [{ x: 0.074, y: 0.15, width: 0.002, height: 0.75, kind: 'line', color: '#C5A059', opacity: 1, radius: null, strokeWidth: null, strokeColor: null, role: 'rule' }],
        text: [
          { copyIndex: 0, role: 'title', x: 0.111, y: 0.18, width: 0.815, height: 0.12, fontSize: 0.035, lineHeight: 1.25, letterSpacing: null, fontFamily: 'Lora', color: '#C5A059', align: 'left', bold: true, italic: false, rtl: false },
          { copyIndex: 1, role: 'body', x: 0.111, y: 0.45, width: 0.750, height: 0.20, fontSize: 0.014, lineHeight: 1.5, letterSpacing: null, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: false, italic: false, rtl: false },
        ],
      },
      {
        id: 'c3', conceptTitle: 'Hero Statement Grid', compositionArchetype: 'hero_statement_grid',
        typeScale: { base: 15, ratio: 1.414 }, grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
        background: { color: '#0A1628' }, logo: { x: 0.407, y: 0.059, width: 0.185, height: 0.074 }, art: null,
        shapes: [{ x: 0.074, y: 0.48, width: 0.852, height: 0.38, kind: 'roundRect', color: '#1E3A5F', opacity: 0.8, radius: 0.015, strokeWidth: null, strokeColor: null, role: 'panel' }],
        text: [
          { copyIndex: 0, role: 'title', x: 0.074, y: 0.18, width: 0.852, height: 0.14, fontSize: 0.038, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Cinzel', color: '#F7B500', align: 'center', bold: true, italic: false, rtl: false },
          { copyIndex: 1, role: 'body', x: 0.111, y: 0.52, width: 0.778, height: 0.25, fontSize: 0.014, lineHeight: 1.5, letterSpacing: null, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left', bold: false, italic: false, rtl: false },
        ],
      },
    ];

    const baseFetch = createMockFetch();
    const schemasSeen: string[] = [];
    let conceptCalls = 0;
    const fetcher = vi.fn().mockImplementation(async (url: any, init: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const schema: string | undefined = body.response_format?.json_schema?.name;
      if (schema) schemasSeen.push(schema);
      if (JSON.stringify(body).includes('genuinely different concepts')) conceptCalls++;
      const reply = (data: unknown) => ({
        ok: true,
        status: 200,
        headers: { get: () => `req_${randomUUID().slice(0, 8)}` },
        json: async () => ({
          id: `chatcmpl-${randomUUID().slice(0, 12)}`,
          model: body.model,
          choices: [{ message: { content: JSON.stringify(data) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
      });
      if (schema === 'layout_v3_candidates') return reply({ layouts: v3Layouts });
      if (schema === 'DesignCritiqueReport') return reply({ overallAssessment: 'Balanced and legible.', comments: [] });
      if (schema === 'PairwiseDimensionVerdict') {
        // A judge that only ever prefers the first position: every pair it sees is a discarded tie.
        const dims = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'];
        return reply({
          dimensions: Object.fromEntries(dims.map((d) => [d, { winner: 'A', rationale: 'position' }])),
          majorityWinner: 'A',
          summary: 'A',
        });
      }
      return baseFetch(url, init);
    });

    try {
      const taskId = await createTask(undefined, pilotChat);
      const mockCanvaService = {
        importEditableDesign: vi.fn().mockResolvedValue({ operationId: randomUUID(), status: 'submitted', designId: 'DAFV3TEST01' }),
      } as unknown as CanvaConnectService;
      const service = new DesignStudioService(db, mockCanvaService, {
        apiKey: 'test-key',
        fetcher,
        defaultTier: 'standard',
      });

      const { run } = await service.createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, {
        width: 1080,
        height: 1350,
        tier: 'standard',
      });

      let status = run.status;
      for (let i = 0; i < 15 && !['transferred', 'failed', 'degraded'].includes(status); i++) {
        status = (await service.resume(scope, taskId, run.id)).status;
      }
      const final = (await sql<any>`SELECT * FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
      expect({ status, diagnostic: final.diagnostic }).toEqual({ status: 'transferred', diagnostic: final.diagnostic });

      // No v2 concept call: v3 invents its own archetypes. And the v3 stages ran.
      expect(conceptCalls).toBe(0);
      expect(schemasSeen).toContain('layout_v3_candidates');
      expect(schemasSeen).toContain('DesignCritiqueReport');
      expect(schemasSeen.filter((x) => x === 'PairwiseDimensionVerdict')).toHaveLength(4);

      const stages = typeof final.stages === 'string' ? JSON.parse(final.stages) : final.stages;
      expect(stages.tournament.pipeline).toBe('v3');
      expect(stages.tournament.decidedBy).toBe('composite_after_tie');
      expect(stages.revise.pipeline).toBe('v3');
      // A judge that picks by position cannot pass a two-order canary.
      expect(final.judge_status).toBe('UNRELIABLE');

      const judgments = (
        await sql<any>`SELECT kind, order_swapped, candidate_a, candidate_b, verdict FROM hawa.design_studio_judgments WHERE run_id=${run.id}::uuid`.execute(db)
      ).rows;
      const kinds = judgments.map((j: any) => `${j.kind}${j.kind === 'pairwise' ? (j.order_swapped ? ':BA' : ':AB') : ''}`).sort();
      expect(kinds).toEqual(['canary', 'critique', 'pairwise:AB', 'pairwise:BA']);
      for (const j of judgments) {
        const verdict = typeof j.verdict === 'string' ? JSON.parse(j.verdict) : j.verdict;
        expect(verdict.pipeline).toBe('v3');
      }

      // Candidates carry the generator's own archetypes, and exactly one is the winner.
      const candidates = (
        await sql<any>`SELECT status, rank, concept FROM hawa.design_studio_candidates WHERE run_id=${run.id}::uuid ORDER BY ordinal`.execute(db)
      ).rows;
      const concepts = candidates.map((c: any) => (typeof c.concept === 'string' ? JSON.parse(c.concept) : c.concept));
      expect(concepts.map((c: any) => c.layoutIdea)).toEqual([
        'v3 monolith_centered',
        'v3 asymmetric_editorial',
        'v3 hero_statement_grid',
      ]);
      expect(candidates.filter((c: any) => c.status === 'winner')).toHaveLength(1);
      expect(final.winner_candidate_id).toBeTruthy();
      expect(mockCanvaService.importEditableDesign).toHaveBeenCalledTimes(1);
    } finally {
      if (originalFlag === undefined) delete process.env.DESIGN_PIPELINE_V3;
      else process.env.DESIGN_PIPELINE_V3 = originalFlag;
      if (originalChats === undefined) delete process.env.DESIGN_PIPELINE_V3_CHATS;
      else process.env.DESIGN_PIPELINE_V3_CHATS = originalChats;
    }
  }, 60000);

  it('7. abandon marks run abandoned and allows a new generation to be started', async () => {
    const taskId = await createTask();
    const fetcher = createMockFetch();
    const service = new DesignStudioService(db, undefined, {
      apiKey: 'test-key',
      fetcher,
      defaultTier: 'standard',
    });

    const key1 = `key-${randomUUID().slice(0, 16)}`;
    const { run: run1 } = await service.createOrGetRun(scope, taskId, key1, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    const abandoned = await service.abandon(scope, taskId, run1.id, 'User requested new theme');
    expect(abandoned.status).toBe('abandoned');

    // Now starting a new run on the same task succeeds
    const key2 = `key-${randomUUID().slice(0, 16)}`;
    const { run: run2, created } = await service.createOrGetRun(scope, taskId, key2, {
      width: 1080,
      height: 1350,
      tier: 'standard',
    });

    expect(created).toBe(true);
    expect(run2.id).not.toBe(run1.id);
  });
});
