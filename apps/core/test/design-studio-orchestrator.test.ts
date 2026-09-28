import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { blobStoreFromEnv, createDb, sql, withRlsContext, DesignStudioRepository, type Database, type Kysely } from '@hawa/db';
import { DesignStudioService, isPipelineV3Run } from '../src/services/design-studio/design-studio-service.js';
import { CanvaConnectService, CanvaFlowError } from '../src/services/canva-connect-service.js';
import { CanvaDesignPlanner } from '../src/services/canva-design-planner.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import type { StudioLayoutV2 } from '@hawa/creative';
import { computeDnaHash } from '../src/core-helpers.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import { checkCanvaPptx } from '@hawa/qa';
import type { HardQAResult } from '../src/services/design-studio/types.js';

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
      if (overrides.transformResult) resultData = overrides.transformResult(resultData, promptText);

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `msg_${randomUUID().slice(0, 8)}`,
          model: body.model,
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

  it('scopes a second-client Studio transfer to its DNA, font, palette and logo', async () => {
    const otherClientId = randomUUID();
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
      VALUES(${otherClientId}::uuid,${scope.tenantId}::uuid,${'other-'+otherClientId.slice(0,8)},'Other Client')`.execute(db);
    const logoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const logoRef = await blobStoreFromEnv(db).put(logoBytes, 'image/png');
    const dna = { tenantId: scope.tenantId, clientId: otherClientId, name: 'Other Client', code: 'other', version: 1,
      status: 'active', defaultLocale: 'en', defaultDirection: 'ltr',
      colors: [{ name: 'Ocean', hex: '#214365', role: 'background' }, { name: 'Paper', hex: '#FAFAFA', role: 'text' },
        { name: 'Rose', hex: '#EFABCD', role: 'accent' }],
      fonts: [{ family: 'Inter', style: 'Regular', weight: 400, role: 'body', license: 'test', supportedLocales: ['en'] },
        { family: 'Noto Sans Arabic', style: 'Regular', weight: 400, role: 'body', license: 'test', supportedLocales: ['ckb','ar'] },
        { family: 'Inter', style: 'Bold', weight: 700, role: 'display', license: 'test', supportedLocales: ['en'] }],
      assets: [{ assetId: randomUUID(), name: 'Other logo', role: 'logo_primary',
        storageKey: `sha256:${logoRef.sha256}`, sha256: logoRef.sha256, mimeType: 'image/png',
        minimumWidthPx: 130, clearSpacePx: 70 }],
      guidelines: { voiceAndTone: 'Clear', prohibitedPhrases: [], requiredDisclaimers: [], layoutRules: ['Use open spacing.'] },
      destinations: { googleSharedDriveId: 'test', productionFolderId: 'test', archiveFolderId: 'test', spreadsheetId: 'test', sheetId: 1 },
      approvalPolicy: { requiredRoles: ['art_director'], allowAutoApproval: false, autoApprovalEligibleTemplates: [] },
      updatedAt: new Date().toISOString() };
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
      VALUES(${scope.tenantId}::uuid,${otherClientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${computeDnaHash(dna)},${scope.actorId}::uuid)`.execute(db);
    const intake = async (chat: string) => (await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(),
      sourceChannelId: chat, clientId: otherClientId, title: '[TEST] Other Studio',
      rawText: 'Use open spacing.\n---\nOTHER TITLE\n\nOther body.', designInstructions: 'Use open spacing.', exactCopy: [] })).task.id;
    const oldFlag=process.env.DESIGN_PIPELINE_V3, oldChats=process.env.DESIGN_PIPELINE_V3_CHATS;
    process.env.DESIGN_PIPELINE_V3='off'; process.env.DESIGN_PIPELINE_V3_CHATS='';
    try {
      const ownPalette = ['#214365', '#FAFAFA', '#EFABCD'];
      const fetcher=createMockFetch({ transformResult: (result: any) => {
        if (Array.isArray(result.concepts)) {
          return { concepts: result.concepts.map((concept: any) => ({ ...concept,
            colourRoles: { background: ownPalette[0], title: ownPalette[1], body: ownPalette[1],
              accent: ownPalette[2], rule: ownPalette[2] } })) };
        }
        if (result.layout) {
          const layout = structuredClone(mockLayout);
          layout.background.color = ownPalette[0];
          layout.shapes[0].color = ownPalette[2];
          layout.text[0].color = ownPalette[1];
          layout.text[1].color = ownPalette[1];
          layout.text.forEach((block) => { block.fontFamily = 'Inter'; });
          layout.logo = { x: 850, y: 1000, width: 140, height: 140 };
          return { layout, notes: 'Client palette, own logo, open spacing' };
        }
        if (result.evidence?.brandFidelity) {
          return { ...result, evidence: { ...result.evidence,
            brandFidelity: 'The design uses only Other Client palette and its official logo' } };
        }
        return result;
      } });
      const mockCanvaService = { importEditableDesign: vi.fn().mockResolvedValue({
        operationId: randomUUID(), status: 'retrieved', designId: 'DAFOTHERCLIENT01',
      }) } as unknown as CanvaConnectService;
      const service=new DesignStudioService(db,mockCanvaService,{apiKey:'test-key',fetcher,defaultTier:'standard'});
      const taskId=await intake('other-standard');
      const {run}=await service.createOrGetRun(scope,taskId,`key-${randomUUID().slice(0,16)}`,{width:1080,height:1350,tier:'standard'});
      expect(run.request.logoSha256).toBe(logoRef.sha256);
      expect((await service.resume(scope,taskId,run.id)).status).toBe('conceiving');
      expect(fetcher).toHaveBeenCalledTimes(1);
      const sent=JSON.stringify(fetcher.mock.calls[0][1]);
      expect(sent).toContain('#214365');
      expect(sent).toContain('Inter');
      expect(sent).not.toContain('KAAE');
      expect(sent).not.toContain('#F7B500');
      expect((await service.resume(scope,taskId,run.id)).status).toBe('laying_out');
      expect((await service.resume(scope,taskId,run.id)).status).toBe('rendering');
      expect((await service.resume(scope,taskId,run.id)).status).toBe('critiquing');
      expect(fetcher.mock.calls.length).toBeGreaterThan(1);
      for (const [, init] of fetcher.mock.calls) {
        const prompt = JSON.stringify(init);
        expect(prompt).not.toContain('KAAE');
        expect(prompt).not.toContain('#F7B500');
      }
      const candidates = (await sql<{layouts:unknown;preview_png:Buffer|null}>`SELECT layouts,preview_png FROM hawa.design_studio_candidates
        WHERE tenant_id=${scope.tenantId}::uuid AND run_id=${run.id}::uuid ORDER BY ordinal`.execute(db)).rows;
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.some(candidate => candidate.preview_png && candidate.preview_png.length > 0)).toBe(true);
      for (const candidate of candidates) {
        const layouts = typeof candidate.layouts === 'string' ? JSON.parse(candidate.layouts) : candidate.layouts;
        if (!Array.isArray(layouts) || !layouts[0]) continue;
        expect(layouts[0].logo.width).toBeGreaterThanOrEqual(130);
        expect(layouts[0].background.color).toBe(ownPalette[0]);
        expect(JSON.stringify(layouts[0])).not.toContain('#F7B500');
      }

      let completed = 'critiquing';
      for (let step = 0; step < 12 && !['transferred', 'failed', 'degraded'].includes(completed); step++) {
        completed = (await service.resume(scope,taskId,run.id)).status;
      }
      expect(completed).toBe('transferred');
      const plan = (await sql<{source_content:Buffer;source_sha256:string;result:unknown}>`SELECT source_content,source_sha256,result
        FROM hawa.canva_design_plans WHERE tenant_id=${scope.tenantId}::uuid AND task_id=${taskId}::uuid AND status='planned'`.execute(db)).rows[0];
      expect(plan).toBeDefined();
      expect(createHash('sha256').update(plan.source_content).digest('hex')).toBe(plan.source_sha256);
      const pptxCheck = checkCanvaPptx(new Uint8Array(plan.source_content), ['OTHER TITLE', 'Other body.'], 'Inter');
      expect(pptxCheck.copyPass).toBe(true);
      expect(pptxCheck.fontPass).toBe(true);
      const result = typeof plan.result === 'string' ? JSON.parse(plan.result) : plan.result as any;
      expect(result.manifest.logoSha256).toBe(logoRef.sha256);
      expect(result.manifest.copy).toEqual(['OTHER TITLE', 'Other body.']);
      expect(mockCanvaService.importEditableDesign).toHaveBeenCalledTimes(1);
      for (const [, init] of fetcher.mock.calls) {
        const prompt = JSON.stringify(init);
        expect(prompt).not.toContain('KAAE');
        expect(prompt).not.toContain('#F7B500');
      }

      const unavailableClientId = randomUUID();
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
        VALUES(${unavailableClientId}::uuid,${scope.tenantId}::uuid,${'font-'+unavailableClientId.slice(0,8)},'Font Unavailable')`.execute(db);
      const unavailableDna = { ...dna, clientId: unavailableClientId, code: 'font-unavailable', name: 'Font Unavailable',
        fonts: dna.fonts.map((font) => font.family === 'Inter'
          ? { ...font, family: 'Missing Hawdesign Test Font' } : font) };
      await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
        VALUES(${scope.tenantId}::uuid,${unavailableClientId}::uuid,1,'active',${JSON.stringify(unavailableDna)}::jsonb,
          ${computeDnaHash(unavailableDna)},${scope.actorId}::uuid)`.execute(db);
      const unavailableTaskId = (await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(),
        sourceChannelId: 'font-unavailable', clientId: unavailableClientId, title: '[TEST] Font unavailable',
        rawText: 'Use open spacing.\n---\nOTHER TITLE\n\nOther body.', designInstructions: 'Use open spacing.', exactCopy: [] })).task.id;
      const callsBeforeFontFailure = fetcher.mock.calls.length;
      await expect(service.createOrGetRun(scope,unavailableTaskId,`key-${randomUUID().slice(0,16)}`,
        {width:1080,height:1350,tier:'standard'})).rejects.toMatchObject({code:'CLIENT_FONT_UNAVAILABLE'});
      expect(fetcher).toHaveBeenCalledTimes(callsBeforeFontFailure);
      expect(mockCanvaService.importEditableDesign).toHaveBeenCalledTimes(1);
      const absentRuns = (await sql<{n:number}>`SELECT count(*)::int AS n FROM hawa.design_studio_runs
        WHERE tenant_id=${scope.tenantId}::uuid AND task_id=${unavailableTaskId}::uuid`.execute(db)).rows[0];
      expect(absentRuns.n).toBe(0);

      const pilotChat=`other-pilot-${randomUUID().slice(0,8)}`;
      process.env.DESIGN_PIPELINE_V3_CHATS=pilotChat;
      const pilotId=await intake(pilotChat);
      const callsBeforePilot = fetcher.mock.calls.length;
      await expect(service.createOrGetRun(scope,pilotId,`key-${randomUUID().slice(0,16)}`,
        {width:1080,height:1350,tier:'standard'})).rejects.toMatchObject({code:'CLIENT_V3_PROFILE_REQUIRED'});
      expect(fetcher).toHaveBeenCalledTimes(callsBeforePilot);

      const staleTaskId=await intake('other-stale');
      const {run:staleRun}=await service.createOrGetRun(scope,staleTaskId,`key-${randomUUID().slice(0,16)}`,
        {width:1080,height:1350,tier:'standard'});
      expect((await service.resume(scope,staleTaskId,staleRun.id)).status).toBe('conceiving');
      const callsBeforeSupersede = fetcher.mock.calls.length;

      await sql`UPDATE hawa.client_dna_versions SET status='superseded'
        WHERE tenant_id=${scope.tenantId}::uuid AND client_id=${otherClientId}::uuid AND version=1`.execute(db);
      const historical = await resolveClientDesignReference(db,scope,otherClientId,1);
      expect(createHash('sha256').update(JSON.stringify(historical.reference)).digest('hex')).toBe(staleRun.request.referenceHash);
      expect(createHash('sha256').update(historical.logo).digest('hex')).toBe(staleRun.request.logoSha256);
      await expect(service.resume(scope,staleTaskId,staleRun.id)).rejects.toMatchObject({code:'CLIENT_REFERENCE_CHANGED'});
      expect(fetcher).toHaveBeenCalledTimes(callsBeforeSupersede);
      const stopped=(await sql<{status:string}>`SELECT status FROM hawa.design_studio_runs WHERE id=${staleRun.id}::uuid`.execute(db)).rows[0];
      expect(stopped.status).toBe('failed');
    } finally {
      if(oldFlag===undefined)delete process.env.DESIGN_PIPELINE_V3;else process.env.DESIGN_PIPELINE_V3=oldFlag;
      if(oldChats===undefined)delete process.env.DESIGN_PIPELINE_V3_CHATS;else process.env.DESIGN_PIPELINE_V3_CHATS=oldChats;
    }
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
    await service.abandon(scope, taskId, res1.run.id, 'cleanup');
  });

  it('2. enforces one active run per task and 2 active runs per tenant', async () => {
    await withRlsContext(db, scope, async (tx) => {
      await sql`UPDATE hawa.design_studio_runs 
        SET status='abandoned' 
        WHERE tenant_id=${scope.tenantId}::uuid 
          AND status NOT IN ('transferred','degraded','failed','abandoned')`.execute(tx);
    });
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

    // Production, 2026-09-18: a Desk run nobody resumed sat at 'briefing' and, with one older
    // leftover, refused every Telegram request with STUDIO_BUSY. Runs left unadvanced for
    // 30 minutes no longer hold a tenant slot; their own task still resumes or abandons them.
    await withRlsContext(db, scope, async (tx) => {
      await sql`UPDATE hawa.design_studio_runs SET updated_at = now() - interval '31 minutes'
        WHERE id IN (${run1.run.id}::uuid, ${run2.run.id}::uuid)`.execute(tx);
    });
    const run3 = await service.createOrGetRun(scope, taskId3, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350 });
    expect(run3.created).toBe(true);
    // Its own task no longer waits on it either (2026-09-24): a run nothing advanced for 30 minutes
    // was given up on, so a new run for the task abandons it and starts, where it used to be refused
    // with STUDIO_RUN_IN_PROGRESS for ever.
    const run4 = await service.createOrGetRun(scope, taskId1, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350 });
    expect(run4.created).toBe(true);
    const run1Now = await withRlsContext(db, scope, async (tx) =>
      (await sql<any>`SELECT status, diagnostic FROM hawa.design_studio_runs WHERE id = ${run1.run.id}::uuid`.execute(tx)).rows[0]);
    expect(run1Now.status).toBe('abandoned');
    expect(run1Now.diagnostic).toContain('no progress');

    await withRlsContext(db, scope, async (tx) => {
      await sql`UPDATE hawa.design_studio_runs SET status = 'abandoned'
        WHERE id IN (${run2.run.id}::uuid, ${run3.run.id}::uuid, ${run4.run.id}::uuid)`.execute(tx);
    });
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
    await service.abandon(scope, taskId, run.id, 'cleanup');
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

  it('5. a lost layout-model reply holds the run instead of paying for a fallback design', async () => {
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
    // The dropped reply may have been accepted and billed; no second design starts.
    await expect(service.resume(scope, taskId, run.id)).rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
    expect(mockPlanner.generate).not.toHaveBeenCalled();
    const held = await withRlsContext(db, scope, (tx) =>
      sql<any>`SELECT status FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(tx));
    expect(held.rows[0].status).toBe('laying_out');
    const calls = await withRlsContext(db, scope, (tx) =>
      sql<any>`SELECT status FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid AND stage='laying_out'`.execute(tx));
    expect(calls.rows.some((call: any) => call.status === 'uncertain')).toBe(true);
    await service.abandon(scope, taskId, run.id, 'test cleanup');
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

      await withRlsContext(db, scope, async (tx) => {
        await sql`UPDATE hawa.design_studio_runs SET status = 'abandoned'
          WHERE id IN (${pilot.run.id}::uuid, ${other.run.id}::uuid)`.execute(tx);
      });
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
    expect(planRow.paid_protocol).toBe('studio-transfer-v1');
    expect(planRow.studio_run_id).toBe(run.id);
    expect((await sql`SELECT id FROM hawa.canva_planner_calls WHERE id=${planRow.id}::uuid`.execute(db)).rows).toHaveLength(0);
    expect(planRow.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(planRow.source_content).toBeDefined();
    expect(run.request.copyBlocks.every((block: { locale?: string; localeCopySha256?: string; text: string }) =>
      block.locale === 'und' && block.localeCopySha256 === createHash('sha256').update(block.text).digest('hex'))).toBe(true);
    expect(planRow.result.manifest.copyLocales).toEqual(run.request.copyBlocks.map(() => 'und'));
    expect(mockCanvaService.importEditableDesign).toHaveBeenCalledTimes(1);
    const final = (await sql<{stages: {qa: HardQAResult}}>`SELECT stages FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
    expect(final.stages.qa.passed).toBe(true);
    expect(final.stages.qa.textMeasurements.map((m) => m.status)).toEqual(run.request.copyBlocks.map(() => 'measured'));
    expect(final.stages.qa.textMeasurements.map((m) => m.copySha256)).toEqual(run.request.copyBlocks.map((b: {text: string}) => createHash('sha256').update(b.text).digest('hex')));
    // ADR-123: final QA retains where art and photos landed; this typography-only design has neither.
    expect(final.stages.qa.placement).toEqual({ version: 1, art: null, photos: [] });
  }, 30000);

  it.each([false, true])('6b. retains final QA for the replacement winner and honors selection hold (%s)', async (holdForSelection) => {
    const taskId = await createTask();
    const service = new DesignStudioService(db, {} as CanvaConnectService, {apiKey: 'test-key', fetcher: createMockFetch(), defaultTier: 'standard'});
    const {run} = await service.createOrGetRun(scope, taskId, `measure-${randomUUID()}`, {width: 1080, height: 1350, tier: 'standard', holdForSelection});
    try {
      let status = run.status;
      for (let i = 0; i < 12 && status !== 'qa'; i++) status = (await service.resume(scope, taskId, run.id)).status;
      expect(status).toBe('qa');
      const repo = new DesignStudioRepository(db);
      const row = (await repo.getCandidatesForRun(run.id, scope.tenantId)).find((r) => r.status === 'winner')!;
      expect(row).toBeDefined();
      const layouts = (row.layouts as Array<string | StudioLayoutV2>).map((l) => typeof l === 'string' ? JSON.parse(l) as StudioLayoutV2 : l);
      const replacementId = randomUUID();
      await repo.insertCandidate({id: replacementId, tenantId: scope.tenantId, runId: run.id, ordinal: 10,
        concept: {}, layouts: layouts as unknown as Record<string, unknown>[], status: 'active'});
      const broken = structuredClone(layouts.at(-1)!);
      broken.text[0].fontSize = 0; // Invalid geometry stays unmeasurable even with real fallback fonts.
      await repo.updateCandidate(row.id, scope.tenantId, {layouts: [broken as unknown as Record<string, unknown>]});
      const result = await service.resume(scope, taskId, run.id);
      expect(result.status).toBe(holdForSelection ? 'awaiting_selection' : 'transferring');
      expect(result.winnerCandidateId).toBe(replacementId);
      const saved = (await sql<{winner_candidate_id: string; stages: {qa: HardQAResult & {candidateId: string}; qaReplacedWinner: HardQAResult & {candidateId: string}}}>`SELECT winner_candidate_id,stages
        FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
      expect(saved.winner_candidate_id).toBe(replacementId);
      expect(saved.stages.qa.passed).toBe(true);
      expect(saved.stages.qa.candidateId).toBe(replacementId);
      expect(saved.stages.qa.textMeasurements.every((m) => m.status === 'measured')).toBe(true);
      expect(saved.stages.qaReplacedWinner.candidateId).toBe(row.id);
      expect(saved.stages.qaReplacedWinner.passed).toBe(false);
      expect(saved.stages.qaReplacedWinner.defectCodes).toContain('COPY_UNMEASURED');
    } finally {
      await service.abandon(scope, taskId, run.id, 'measurement test cleanup');
    }
  }, 30000);

  it('6d. a Canva rate limit on the import leaves the run at transfer and names the wait; the next resume imports under the same key', async () => {
    const taskId = await createTask();
    const operationId = randomUUID();
    const mockCanvaService = {
      importEditableDesign: vi.fn()
        .mockRejectedValueOnce(new CanvaFlowError(429, 'CANVA_RATE_LIMITED', 'Canva is refusing new imports for now.', 20000))
        .mockResolvedValue({ operationId, status: 'retrieved', designId: 'DAFRATELIMIT1' }),
    } as unknown as CanvaConnectService;
    const service = new DesignStudioService(db, mockCanvaService, { apiKey: 'test-key', fetcher: createMockFetch(), defaultTier: 'standard' });
    const { run } = await service.createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
    let refusal: any = null;
    for (let n = 0; n < 15 && !refusal; n++) {
      const step = await service.resume(scope, taskId, run.id).catch((err) => { refusal = err; return null; });
      if (step && ['transferred', 'failed', 'degraded'].includes(step.status)) break;
    }
    expect({ status: refusal?.status, code: refusal?.code, retryAfterMs: refusal?.retryAfterMs }).toEqual({ status: 429, code: 'CANVA_RATE_LIMITED', retryAfterMs: 20000 });
    const held = (await sql<any>`SELECT status FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
    expect(held.status).toBe('transferring');

    const done = await service.resume(scope, taskId, run.id);
    expect({ status: done.status, designId: done.designId }).toEqual({ status: 'transferred', designId: 'DAFRATELIMIT1' });
    const calls = (mockCanvaService.importEditableDesign as any).mock.calls;
    expect(calls.map((c: any[]) => c[2])).toEqual([`studio-${run.id}`, `studio-${run.id}`]);
    const plans = (await sql<any>`SELECT id FROM hawa.canva_design_plans WHERE task_id=${taskId}::uuid`.execute(db)).rows;
    expect(plans).toHaveLength(1);
  }, 30000);

  it('6c. an import Canva has not settled leaves the run at transfer; the next resume follows the same import (2026-09-24)', async () => {
    const taskId = await createTask();
    const operationId = randomUUID();
    let canvaDone = false;
    const mockCanvaService = {
      importEditableDesign: vi.fn().mockResolvedValue({ operationId, status: 'submitted' }),
      resumeImport: vi.fn(async () => (canvaDone ? { operationId, status: 'retrieved', designId: 'DAFSLOWIMPORT1' } : { operationId, status: 'submitted' })),
    } as unknown as CanvaConnectService;
    const service = new DesignStudioService(db, mockCanvaService, { apiKey: 'test-key', fetcher: createMockFetch(), defaultTier: 'standard' });
    // The transfer stage polls every 1.5 s, 30 times; this test does not wait for real.
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === 1500 ? 0 : ms, ...rest)) as typeof setTimeout);
    try {
      const { run } = await service.createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
      let step: any = { status: run.status };
      for (let n = 0; n < 15 && step.stage !== 'transfer' && !['transferred', 'failed', 'degraded'].includes(step.status); n++) {
        step = await service.resume(scope, taskId, run.id);
      }
      // Canva is still importing: the run waits at its stage instead of failing.
      expect({ status: step.status, stage: step.stage }).toEqual({ status: 'transferring', stage: 'transfer' });

      canvaDone = true;
      const done = await service.resume(scope, taskId, run.id);
      expect({ status: done.status, designId: done.designId }).toEqual({ status: 'transferred', designId: 'DAFSLOWIMPORT1' });

      // Both attempts imported the same deck under the run's own key, from the one plan row.
      const calls = (mockCanvaService.importEditableDesign as any).mock.calls;
      expect(calls.map((c: any[]) => c[2])).toEqual([`studio-${run.id}`, `studio-${run.id}`]);
      expect(calls[1][3].sha256).toBe(calls[0][3].sha256);
      const plans = (await sql<any>`SELECT id FROM hawa.canva_design_plans WHERE task_id=${taskId}::uuid`.execute(db)).rows;
      expect(plans).toHaveLength(1);
    } finally {
      timers.mockRestore();
    }
  }, 30000);

  it.each(['dev', 'production'] as const)('6b. %s: a pilot chat\'s run goes through the shared v3 stages, records every judgement, and transfers', async modelTier => {
    const originalTier = process.env.HAWA_MODEL_TIER;
    process.env.HAWA_MODEL_TIER = modelTier;
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
      if (originalTier === undefined) delete process.env.HAWA_MODEL_TIER;
      else process.env.HAWA_MODEL_TIER = originalTier;
      if (originalFlag === undefined) delete process.env.DESIGN_PIPELINE_V3;
      else process.env.DESIGN_PIPELINE_V3 = originalFlag;
      if (originalChats === undefined) delete process.env.DESIGN_PIPELINE_V3_CHATS;
      else process.env.DESIGN_PIPELINE_V3_CHATS = originalChats;
    }
  }, 60000);

  /** The three generator layouts of 6b, which reach the judge through actual hard QA. */
  const judgeFixtureLayouts = () => [
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

  it('6d. HAWA_STUDIO_JUDGE_PROTOCOL=brief_bound_v1 judges with the actual brief and exact copy and records the challenger (ADR-124)', async () => {
    const saved = { flag: process.env.DESIGN_PIPELINE_V3, chats: process.env.DESIGN_PIPELINE_V3_CHATS,
      protocol: process.env.HAWA_STUDIO_JUDGE_PROTOCOL, tier: process.env.HAWA_MODEL_TIER };
    const pilotChat = `isolated-judge-${randomUUID().slice(0, 8)}`;
    process.env.DESIGN_PIPELINE_V3 = 'off';
    process.env.DESIGN_PIPELINE_V3_CHATS = pilotChat;
    process.env.HAWA_STUDIO_JUDGE_PROTOCOL = 'brief_bound_v1';
    process.env.HAWA_MODEL_TIER = 'dev';
    const v3Layouts = judgeFixtureLayouts();
    const baseFetch = createMockFetch();
    const challengerRequests: string[] = [];
    const schemasSeen: string[] = [];
    let challengerCall = 0;
    const fetcher = vi.fn().mockImplementation(async (url: any, init: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const schema: string | undefined = body.response_format?.json_schema?.name;
      if (schema) schemasSeen.push(schema);
      const reply = (data: unknown) => ({ ok: true, status: 200, headers: { get: () => `req_${randomUUID().slice(0, 8)}` },
        json: async () => ({ id: `chatcmpl-${randomUUID().slice(0, 12)}`, model: body.model,
          choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }) });
      if (schema === 'layout_v3_candidates') return reply({ layouts: v3Layouts });
      if (schema === 'DesignCritiqueReport') return reply({ overallAssessment: 'Balanced and legible.', comments: [] });
      if (schema === 'BriefBoundDimensionVerdict') {
        challengerRequests.push(init.body);
        challengerCall++;
        const d = (c: string, m: string, a: string) => ({ correctness: { choice: c, reason: 'Every exact block is present.' },
          communication: { choice: m, reason: 'The title is found first.' }, aesthetic: { choice: a, reason: 'Calm balance.' } });
        // Pair: the second-ranked candidate wins communication in both orders. Canary: the chosen design beats its degraded copy.
        const answers = [d('tie', 'B', 'tie'), d('tie', 'A', 'tie'), d('A', 'A', 'A'), d('B', 'B', 'B')];
        return reply({ dimensions: answers[challengerCall - 1], findings: [] });
      }
      return baseFetch(url, init);
    });
    try {
      const taskId = await createTask(undefined, pilotChat);
      const mockCanvaService = {
        importEditableDesign: vi.fn().mockResolvedValue({ operationId: randomUUID(), status: 'submitted', designId: 'DAFV3JUDGE1' }),
      } as unknown as CanvaConnectService;
      const service = new DesignStudioService(db, mockCanvaService, { apiKey: 'test-key', fetcher, defaultTier: 'standard' });
      const { run } = await service.createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
      let status = run.status;
      for (let i = 0; i < 15 && !['transferred', 'failed', 'degraded'].includes(status); i++) {
        status = (await service.resume(scope, taskId, run.id)).status;
      }
      const final = (await sql<any>`SELECT * FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
      expect({ status, diagnostic: final.diagnostic }).toEqual({ status: 'transferred', diagnostic: final.diagnostic });
      expect(schemasSeen).not.toContain('PairwiseDimensionVerdict');
      expect(challengerRequests).toHaveLength(4);
      for (const request of challengerRequests) {
        expect(request).toContain('EXACT TITLE');
        expect(request).toContain('Exact body text line. Never rewrite it.');
        expect(request).toContain('Keep title centered.');
        expect(request).not.toMatch(/Composite Score|GROUND TRUTH|prestige|gravitas/);
      }
      const stages = typeof final.stages === 'string' ? JSON.parse(final.stages) : final.stages;
      expect(stages.tournament).toMatchObject({ pipeline: 'v3', judgeProtocol: 'brief_bound_v1', decidedBy: 'judge', humanChoiceRecommended: false });
      expect(stages.canary).toEqual({ passed: true });
      expect(final.judge_status).toBe('RELIABLE');
      const judgments = (await sql<any>`SELECT kind, order_swapped, candidate_a, candidate_b, verdict FROM hawa.design_studio_judgments
        WHERE run_id=${run.id}::uuid AND kind IN ('pairwise','canary') ORDER BY kind, order_swapped`.execute(db)).rows;
      expect(judgments.map((j: any) => `${j.kind}:${j.order_swapped}`)).toEqual(['canary:false', 'pairwise:false', 'pairwise:true']);
      for (const j of judgments) {
        const verdict = typeof j.verdict === 'string' ? JSON.parse(j.verdict) : j.verdict;
        expect(verdict).toMatchObject({ pipeline: 'v3', protocol: 'brief-bound-dimensional-v1' });
      }
      const pairAB = judgments.find((j: any) => j.kind === 'pairwise' && !j.order_swapped);
      const abVerdict = typeof pairAB.verdict === 'string' ? JSON.parse(pairAB.verdict) : pairAB.verdict;
      expect(abVerdict.verdict.dimensions.communication.choice).toBe('B');
      expect(abVerdict.packetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(abVerdict.receipt.responseId).toMatch(/^chatcmpl-/);
      const winner = (await sql<any>`SELECT id FROM hawa.design_studio_candidates WHERE run_id=${run.id}::uuid AND status='winner'`.execute(db)).rows;
      expect(winner).toHaveLength(1);
      expect(winner[0].id).toBe(pairAB.candidate_b);
    } finally {
      const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
      restore('DESIGN_PIPELINE_V3', saved.flag);
      restore('DESIGN_PIPELINE_V3_CHATS', saved.chats);
      restore('HAWA_STUDIO_JUDGE_PROTOCOL', saved.protocol);
      restore('HAWA_MODEL_TIER', saved.tier);
    }
  }, 60000);

  it('6e. an unknown HAWA_STUDIO_JUDGE_PROTOCOL value is refused visibly; the composite stands without any judge call (ADR-124)', async () => {
    const saved = { flag: process.env.DESIGN_PIPELINE_V3, chats: process.env.DESIGN_PIPELINE_V3_CHATS, protocol: process.env.HAWA_STUDIO_JUDGE_PROTOCOL };
    const pilotChat = `isolated-judge-bad-${randomUUID().slice(0, 8)}`;
    process.env.DESIGN_PIPELINE_V3 = 'off';
    process.env.DESIGN_PIPELINE_V3_CHATS = pilotChat;
    process.env.HAWA_STUDIO_JUDGE_PROTOCOL = 'on';
    const v3Layouts = judgeFixtureLayouts();
    const baseFetch = createMockFetch();
    const schemasSeen: string[] = [];
    const fetcher = vi.fn().mockImplementation(async (url: any, init: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const schema: string | undefined = body.response_format?.json_schema?.name;
      if (schema) schemasSeen.push(schema);
      const reply = (data: unknown) => ({ ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: `chatcmpl-${randomUUID().slice(0, 12)}`, model: body.model,
          choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }) });
      if (schema === 'layout_v3_candidates') return reply({ layouts: v3Layouts });
      if (schema === 'DesignCritiqueReport') return reply({ overallAssessment: 'Balanced and legible.', comments: [] });
      return baseFetch(url, init);
    });
    try {
      const taskId = await createTask(undefined, pilotChat);
      const mockCanvaService = {
        importEditableDesign: vi.fn().mockResolvedValue({ operationId: randomUUID(), status: 'submitted', designId: 'DAFV3JUDGE2' }),
      } as unknown as CanvaConnectService;
      const service = new DesignStudioService(db, mockCanvaService, { apiKey: 'test-key', fetcher, defaultTier: 'standard' });
      const { run } = await service.createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
      let status = run.status;
      for (let i = 0; i < 15 && !['transferred', 'failed', 'degraded'].includes(status); i++) {
        status = (await service.resume(scope, taskId, run.id)).status;
      }
      const final = (await sql<any>`SELECT * FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
      expect(schemasSeen.filter((s) => s === 'PairwiseDimensionVerdict' || s === 'BriefBoundDimensionVerdict')).toEqual([]);
      const stages = typeof final.stages === 'string' ? JSON.parse(final.stages) : final.stages;
      expect(stages.tournament.decidedBy).toBe('composite_judge_unavailable');
      expect(stages.tournament.error).toMatch(/HAWA_STUDIO_JUDGE_PROTOCOL/);
      // The refusal is countable by its code, not only readable as prose.
      expect(stages.tournament.errorCode).toBe('STUDIO_JUDGE_PROTOCOL_INVALID');
      expect(stages.tournament.humanChoiceRecommended).toBe(true);
      expect(final.judge_status).toBe('SKIPPED');
    } finally {
      const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
      restore('DESIGN_PIPELINE_V3', saved.flag);
      restore('DESIGN_PIPELINE_V3_CHATS', saved.chats);
      restore('HAWA_STUDIO_JUDGE_PROTOCOL', saved.protocol);
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
    await service.abandon(scope, taskId, run2.id, 'cleanup');
  });
});
