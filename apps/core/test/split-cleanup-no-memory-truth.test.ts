import {runReceiptAudit} from './fixtures/run-receipt-audit.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, TaskRepository, withRlsContext } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import {persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import { deskReviewTarget } from '@hawa/contracts/desk-navigation';

/**
 * The cleanup step of the app.ts split (architecture programme 1.3, SPLIT_PLAN.md section 7): with a
 * database, Core keeps no task, event, brief or asset of its own. Each case writes through one Core
 * and reads through a second on the same database, which is what a restart or a second replica is:
 * the second answered from its own (empty) maps, or from what it had loaded at start-up.
 */

const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

const TENANT = '00000000-0000-4000-a000-000000000001';
/** Seeded client rows: KAAE's inline template needs a headline; Hawa Studio's design is generic. */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const HAWA_STUDIO = 'c1000000-0000-4000-8000-000000000001';
const json = { 'Content-Type': 'application/json' };
const artDirector = { ...json, Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };

type App = ReturnType<typeof createApp>;
const core = (): App => createApp({ db: testDb, testAuth: { principal: { role: 'art_director' } } });
beforeAll(()=>persistClientDnaFixture(core(),HAWA_STUDIO,{},undefined,'client-office-1'));

async function newTask(app: App, body: Record<string, unknown>): Promise<string> {
  const res = await app.request('/v1/tasks', { method: 'POST', headers: json, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

describe('with a database, tasks are read from Postgres only', () => {
  it('lists the failures Postgres holds, for a task another Core created', async () => {
    const taskId = await newTask(core(), { title: 'Cleanup: failed elsewhere', clientId: KAAE });
    // The worker, or another Core, marks the task for an operator.
    await withRlsContext(testDb, { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (trx) =>
      new TaskRepository(testDb).transitionState({ taskId, tenantId: TENANT, toState: 'failed_operator', actorType: 'workflow', actorId: 'test', reason: 'Canva import failed' }, trx));

    const res = await core().request('/v1/operations/failures');
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((t: { id: string }) => t.id === taskId);
    expect(item).toMatchObject({ id: taskId, title: 'Cleanup: failed elsewhere', status: 'OPERATOR_REQUIRED', clientId: KAAE });
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('audits the tasks Postgres holds, not only those this Core touched', async () => {
    await newTask(core(), { title: 'Cleanup: audited elsewhere', clientId: KAAE });
    const res = await runReceiptAudit(core(),json);
    expect(res.status).toBe(201);
    expect((await res.json()).totalTasksAudited).toBeGreaterThanOrEqual(1);
  });

  it('generates from the copy the task was created with, in a Core that did not create it', async () => {
    const taskId = await newTask(core(), { title: 'Cleanup: KAAE copy', clientId: KAAE, headlineCkb: 'بەخێربێن بۆ کەی ئەی ئەی ئی' });
    // A KAAE request without a headline is refused COPY_REQUIRED. The creating Core kept the headline
    // in memory; any other Core read the task without it and answered COPY_REQUIRED. Read now, the
    // copy passes, and the legacy generator refuses KAAE itself: it is designed in the studio (ADR-127).
    const res = await core().request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });
    expect(res.status).toBe(410);
    expect((await res.json()).title).toBe('LEGACY_TEMPLATES_RETIRED');
  });

  it('generates from the brief another Core saved', async () => {
    const a = core();
    const taskId = await newTask(a, { title: 'Cleanup: title only', clientId: HAWA_STUDIO });
    const brief = await a.request(`/v1/tasks/${taskId}/briefs`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ objective: 'Spring offer', rawRequestText: 'Brief copy saved in Postgres' }),
    });
    expect(brief.status).toBe(201);

    const b = core();
    const generated = await b.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });
    expect(generated.status).toBe(202);
    const { revisionId } = await generated.json();
    const { revision } = await (await b.request(`/v1/tasks/${taskId}/revisions/${revisionId}`)).json();
    const texts = (revision.document?.nodes || []).map((n: { text?: string }) => n.text).filter(Boolean);
    // Without the brief, the design was drawn from the task's title.
    expect(texts).toContain('Brief copy saved in Postgres');
    expect(texts).not.toContain('Cleanup: title only');
  });

  it('shows the QC run Postgres holds on another Core\'s review desk', async () => {
    const taskId = await newTask(core(), { title: 'Cleanup: review desk', clientId: HAWA_STUDIO, headlineEn: 'Accreditation results' });
    const generated = await core().request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });
    expect(generated.status).toBe(202);
    // The generator draws a placeholder logo, so QA fails; the evidence was "not run" on every Core
    // but the one that generated the design.
    const desk = await (await core().request(`/v1/tasks/${taskId}/review-desk`)).json();
    expect(desk.qaEvidence).toMatchObject({ status: 'failed', criticalPass: false });
    expect(desk.qaEvidence.qcReportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts revision requests made through other Cores toward the repair budget', async () => {
    const taskId = await newTask(core(), { title: 'Cleanup: three rounds', clientId: HAWA_STUDIO, headlineEn: 'Three rounds' });
    const round = async (comment: string) => {
      const app = core();
      expect((await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' })).status).toBe(202);
      const { latestRevisionId } = await (await app.request(`/v1/tasks/${taskId}`)).json();
      const res = await core().request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment } }),
      });
      expect(res.status).toBe(201);
      return (await (await core().request(`/v1/tasks/${taskId}`)).json()).status;
    };
    expect(await round('Fix the colours')).toBe('REVISION_REQUESTED');
    expect(await round('Fix the alignment')).toBe('REVISION_REQUESTED');
    // The third request exceeds the budget of two. Each Core counted only the rounds it had seen.
    expect(await round('Still wrong')).toBe('OPERATOR_REQUIRED');
  });

  it('finds a task another Core created', async () => {
    const taskId = await newTask(core(), { title: 'Cleanup Zagroswinter probe', clientId: KAAE });
    const res = await core().request('/v1/search?q=Zagroswinter');
    expect(res.status).toBe(200);
    const results = (await res.json()).results as Array<{id:string;url:string}>;
    const found = results.find(r => r.id === taskId);
    expect(found).toBeDefined();
    expect(deskReviewTarget(found!.url)).toMatchObject({taskId});
  });

  it('keeps a promoted message as a task in Postgres, once', async () => {
    const a = core();
    const messageId = `msg-cleanup-${Date.now()}`;
    const first = await a.request(`/v1/messages/${messageId}/promote`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'Promoted in cleanup' }) });
    expect(first.status).toBe(201);
    const { id } = await first.json();
    const again = await a.request(`/v1/messages/${messageId}/promote`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'Promoted in cleanup' }) });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
    // The task was this Core's memory alone: another Core, or this one after a restart, had no such task.
    expect((await core().request(`/v1/tasks/${id}`)).status).toBe(200);
  });
});

describe('with a database, client DNA and assets are read from Postgres', () => {
  it('lists the DNA Postgres holds now, not what it held when this Core started', async () => {
    const b = core();
    await (b as unknown as { clientDnaHydrated: Promise<number> }).clientDnaHydrated;
    const name = `KAAE renamed ${Date.now()}`;
    const saved = await core().request(`/v1/clients/${KAAE}/dna`, {
      method: 'POST',
      headers: artDirector,
      body: JSON.stringify({ ...kaaeClientDNA, clientId: KAAE, name, commitMessage: 'Cleanup: renamed elsewhere' }),
    });
    expect(saved.status).toBe(201);
    const listed = (await (await b.request('/v1/clients')).json()) as Array<{ clientId: string; name: string }>;
    expect(listed.find((c) => c.clientId === KAAE)?.name).toBe(name);
  });

  it('keeps an uploaded asset for the next Core', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const uploaded = await core().request('/v1/assets/upload', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ filename: 'cleanup-mark.svg', mimeType: 'image/svg+xml', content: svg, clientId: KAAE, category: 'logo' }),
    });
    expect(uploaded.status).toBe(201);
    const record = await uploaded.json();
    expect(record.clientId).toBe(KAAE);

    const listed = (await (await core().request(`/v1/assets?clientId=${KAAE}`)).json()) as Array<{ assetId: string; sha256: string }>;
    expect(listed.find((a) => a.assetId === record.assetId)?.sha256).toBe(record.sha256);
  });

  it('refuses an asset for a client Postgres does not know', async () => {
    const res = await core().request('/v1/assets/upload', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ filename: 'x.svg', mimeType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg"/>', clientId: 'client-nobody' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('what was never stored is not served', () => {
  const app = () => createAppWithClientFixtures({ testAuth: { principal: { role: 'art_director' } } });

  it('retires the legacy export package, which listed files that were never made', async () => {
    const office = app();
    const created = await office.request('/v1/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Package' }) });
    const { id } = await created.json();
    expect((await office.request(`/v1/tasks/${id}/export-package`)).status).toBe(410);
  });

  it('serves no font file it was never given', async () => {
    const res = await app().request('/v1/fonts/cdn/NeverPackaged/font.woff2');
    expect(res.status).toBe(404);
    // The stylesheet is derived from the family name, so it still answers, with local() fallbacks.
    const css = await app().request('/v1/fonts/cdn/NeverPackaged/style.css');
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("font-family: 'NeverPackaged'");
  });
});
