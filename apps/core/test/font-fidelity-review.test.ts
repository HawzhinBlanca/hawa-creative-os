import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb, DesignStudioRepository, sql, withRlsContext } from '@hawa/db';
import { OpenAiStudioClient, renderMotifPng, type StudioLayoutV2, type RenderLayoutOptions } from '@hawa/creative';
import { resolveRsvgConvert } from '../../../packages/creative/src/studio/renderer-identity.js';
import { runQAStage } from '../src/services/design-studio/stages/qa.stage.js';
import { studioStatusNote, requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import type { StageContext, CandidateState } from '../src/services/design-studio/types.js';
import { createApp } from '../src/app.js';

const runtime = vi.hoisted(() => ({ renderer: '' }));
vi.mock('@hawa/creative', async original => {
  const actual = await original<typeof import('@hawa/creative')>();
  return { ...actual, renderLayoutV2Async: (layout: StudioLayoutV2, options?: RenderLayoutOptions) =>
    actual.renderLayoutV2Async(layout, { ...options, rsvgConvertPath: runtime.renderer }) };
});
const url = process.env.HAWA_ISOLATED_TEST_DB;
const dirs: string[] = [];
afterEach(() => { runtime.renderer = ''; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

describe.skipIf(!url)('actual font fidelity through Core saved review (ADR202)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  afterAll(() => db.destroy());
  it('retains an actual unmeasured-render warning through QA, scoped database, HTTP and office/requester notes with zero providers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hawa-core-fidelity-')); dirs.push(dir);
    runtime.renderer = join(dir, 'rsvg-convert');
    const real = resolveRsvgConvert().replace(/'/g, `'\\''`);
    writeFileSync(runtime.renderer, `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 3; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const tenantId = '00000000-0000-4000-a000-000000000001';
    const actorId = randomUUID(), taskId = randomUUID(), clientId = randomUUID(), runId = randomUUID();
    const wording = 'Exact report wording.';
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('No provider dispatch authorized in this fixture'); });
    const logo = renderMotifPng('thin-rules', { width: 100, height: 100, palette: ['#000000', '#FFFFFF'] });
    const context: StageContext = {
      runId, tenantId, taskId, clientId, actorId, width: 1080, height: 1350, tier: 'standard',
      instructions: 'A report with the exact supplied copy.', copyBlocks: [{ text: wording, script: 'latin' }],
      referencePack: { palette: ['#FFFFFF', '#000000'] }, promotedRules: '', latinFont: 'Amiri', arabicFont: 'Amiri', logoAspect: 1,
      client: new OpenAiStudioClient({ apiKey: 'synthetic-key', fetcher: transport }),
      logo: { bytes: logo, sha256: hash(logo), mimeType: 'image/png' },
    };
    const layout: StudioLayoutV2 = {
      version: 2, width: 1080, height: 1350, grid: { margin: 76, columns: 6, gutter: 26, baseline: 8 },
      background: { color: '#FFFFFF' }, shapes: [], logo: { x: 490, y: 80, width: 100, height: 100 },
      text: [{ copyIndex: 0, role: 'body', x: 76, y: 300, width: 928, height: 100, fontSize: 28,
        lineHeight: 1.4, fontFamily: 'Amiri', color: '#000000', align: 'center' }],
    };
    const candidate: CandidateState = { id: randomUUID(), ordinal: 0, status: 'winner', layouts: [layout], currentLayout: layout, critiques: [],
      concept: { id: 'report', name: 'Report', archetype: 'typographic-poster', artStrategy: 'none',
        typographicScale: { ratio: 1.3, titleSize: 48, bodySize: 28 },
        colourRoles: { background: '#FFFFFF', title: '#000000', body: '#000000', accent: '#000000', rule: '#000000' },
        layoutIdea: 'Live copy in a calm field', whyDifferent: 'Brief-selected typography' } };
    const qa = await runQAStage(context, candidate);
    expect(qa.passed).toBe(true);
    expect(qa.findings?.map(f => f.code)).toContain('FONT_FIDELITY_UNMEASURED');
    expect(qa.measuredContrast?.[0]).toBeGreaterThan(4.5);
    expect(qa.textMeasurements[0]).toMatchObject({ status: 'measured', copySha256: hash(wording) });
    expect(context.copyBlocks[0].text).toBe(wording);

    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId + '@example.test'},'Fidelity operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId, userId: actorId }, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${'fidelity-' + clientId},'Synthetic office')`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Font review')`.execute(tx);
    });
    const repo = new DesignStudioRepository(db);
    const request = { clientId, copyBlocks: context.copyBlocks, width: context.width, height: context.height };
    await repo.createRun({ id: runId, tenantId, taskId, clientId, actorId, requestKey: runId, requestHash: hash(JSON.stringify(request)), request, tier: 'standard' });
    await repo.updateRunStatus(runId, tenantId, 'briefing', { expectedStatus: 'briefing', stages: { qa } });
    const saved = await repo.getRunById(runId, tenantId);
    expect(saved?.stages).toMatchObject({ qa: { findings: qa.findings } });
    const svc = new DesignStudioService(db, undefined, { apiKey: 'synthetic-key', fetcher: transport });
    const app = createApp({ db, designStudioService: svc, testAuth: { principal: { role: 'operator', userId: actorId } } });
    const response = await app.request(`/v1/tasks/${taskId}/canva/studio/${runId}`, { headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run.stages.qa.findings).toEqual(qa.findings);
    expect(studioStatusNote({ run: { ...saved, stages: body.run.stages }, candidates: [] })).toContain('could not be verified');
    expect(requesterDraftNotes({ run: { ...saved, stages: body.run.stages }, candidates: [] }).join(' ')).toContain('could not be verified');
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps requester font notices plain, bounded and separate from other internal QA findings', () => {
    const findings = [null,
      { code: 'FONT_SUBSTITUTED', message: 'FONT_SUBSTITUTED: the renderer drew a stand-in for Amiri.' },
      { code: 'FONT_FIDELITY_UNCOVERED', message: 'FONT_FIDELITY_UNCOVERED: the local face does not cover the sample.' },
      { code: 'CONTRAST_UNMEASURED', message: 'Internal contrast diagnostic' },
      { code: 'FONT_FIDELITY_UNMEASURED', message: '' },
      { code: 'FONT_FIDELITY_UNMEASURED', message: 'FONT_FIDELITY_UNMEASURED: ' + 'Long '.repeat(200) },
    ];
    const run = { stages: JSON.stringify({ qa: { findings } }) }; const before = structuredClone(run);
    const notes = requesterDraftNotes({ run, candidates: [] });
    expect(notes).toHaveLength(3);
    expect(notes[0]).toBe('⚠️ Check before approving: the renderer drew a stand-in for Amiri.');
    expect(notes[1]).toContain('does not cover');
    expect(notes[2].length).toBeLessThanOrEqual('⚠️ Check before approving: '.length + 500);
    expect(notes.join(' ')).not.toMatch(/FONT_|Internal contrast/);
    expect(run).toEqual(before);
    expect(requesterDraftNotes({ run: { stages: {} }, candidates: [] })).toEqual([]);
  });
});
