import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { manifestFromOperations } from '../src/services/generated-manifest.js';

/**
 * /generate runs the deterministic QA engine on the design it generates. It used to store a literal
 * all-pass report ({ criticalPass: true, score: 100, contrast 7.2 }) as a passing QC run, and the
 * approval gate trusted it. Owner decision (2026-09-19): a failing design goes to review with its real
 * findings and cannot be approved until a revision passes.
 */

const json = { 'Content-Type': 'application/json' };

async function generate(app: ReturnType<typeof createApp>, clientId: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = json) {
  const created = await (await app.request('/v1/tasks', { method: 'POST', headers: { ...headers, 'Idempotency-Key': `gen_${crypto.randomUUID()}` }, body: JSON.stringify({ clientId, ...extra }) })).json();
  const taskId: string = created.id;
  await app.request(`/v1/tasks/${taskId}/route`, { method: 'POST', headers, body: JSON.stringify({ clientId, reason: 'Client assigned' }) });
  await app.request(`/v1/tasks/${taskId}/briefs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ objective: 'Launch', rawRequestText: 'Launch', primaryLanguage: 'ckb', direction: 'rtl' }),
  });
  const res = await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST', headers });
  expect(res.status).toBe(202);
  const task = await (await app.request(`/v1/tasks/${taskId}`, { headers })).json();
  return { taskId, task };
}

describe('the generated design is what QA inspects', () => {
  it('maps studio operations to typed nodes, keeping geometry, style and the logo hash', () => {
    const manifest = manifestFromOperations(
      [
        { op: 'addVector', nodeId: 'node_bg', pageId: 'v1', source: '<rect fill="#0A1628"/>', x: 0, y: 0, width: 1080, height: 1350, locked: true },
        { op: 'addImage', nodeId: 'node_logo', pageId: 'v1', asset: { storageKey: 'k', sha256: 'a'.repeat(64), mimeType: 'image/png' }, x: 40, y: 40, width: 240, height: 80, fit: 'contain', locked: true },
        { op: 'addText', nodeId: 'node_text_0', pageId: 'v1', text: 'ڕاگەیاندن', role: 'headline', x: 60, y: 200, width: 900, height: 120, style: { fontFamily: 'Noto Sans Arabic', color: '#FFFFFF', fontSize: 64 } },
      ],
      [{ id: 'v1', name: 'Post', width: 1080, height: 1350, unit: 'px', language: 'ckb', direction: 'rtl' }]
    );
    expect(manifest.nodes).toEqual([
      expect.objectContaining({ id: 'node_bg', type: 'vector', role: 'background', fillColor: '#0A1628', box: { x: 0, y: 0, width: 1080, height: 1350 } }),
      expect.objectContaining({ id: 'node_logo', type: 'image', role: 'logo_primary', assetSha256: 'a'.repeat(64), box: { x: 40, y: 40, width: 240, height: 80 } }),
      expect.objectContaining({ id: 'node_text_0', type: 'text', role: 'headline', text: 'ڕاگەیاندن', color: '#FFFFFF', fontFamily: 'Noto Sans Arabic' }),
    ]);
    expect(manifest.assets).toEqual([expect.objectContaining({ sha256: 'a'.repeat(64), role: 'logo_primary' })]);
    expect(manifest.fonts).toEqual([{ family: 'Noto Sans Arabic', style: 'Regular' }]);
  });
});

describe('/generate runs real QA', () => {
  it('stores the engine\'s report, with its findings and a real hash, and sends a failing design to review', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });
    const { task } = await generate(app, 'client-nova', { title: 'Nova launch' });

    const report = task.latestQAReport;
    expect(report).not.toHaveProperty('score');
    expect(report).not.toHaveProperty('details');
    expect(Array.isArray(report.checks) && report.checks.length).toBeGreaterThan(0);
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/);
    // The generic generator draws a placeholder logo hash, not Nova's official logo.
    expect(report.criticalPass).toBe(false);
    expect(report.findings.map((f: any) => f.ruleId)).toContain('OFFICIAL_LOGO_MISSING_OR_MUTATED');
    expect(task.status).toBe('AWAITING_APPROVAL');
  });

  it('the revision keeps typed nodes, so the review desk lists the exact copy', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });
    const { taskId } = await generate(app, 'client-drustee', { title: 'Vitamin D3', headlineEn: 'Pure Vitamin D3 + K2 Drops', copyEn: '5000 IU, lab tested' });
    const desk = await (await app.request(`/tasks/${taskId}/review-desk`, { headers: { Authorization: 'Bearer test_bearer' } })).json();
    expect(desk.exactCopy.map((c: any) => c.text)).toEqual(expect.arrayContaining(['Pure Vitamin D3 + K2 Drops']));
    expect(desk.qaEvidence).toMatchObject({ status: 'failed', criticalPass: false });
  });
});

describe('/generate with a database', () => {
  it('stores the QC run as it came out: failed, not critical-pass, hashed from the report Core produced', async () => {
    const db = createDb(process.env.TEST_DATABASE_URL!);
    const tenantId = '00000000-0000-4000-a000-000000000001';
    const auth = { ...json, Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
    const app = createApp({ testAuth: { roleHeader: true },  db });
    const { taskId } = await generate(
      app,
      'c1000000-0000-4000-8000-000000000002',
      { title: 'KAAE accreditation announcement', headlineEn: 'Accreditation Announcement', copyEn: 'KAAE announces accreditation results.' },
      auth
    );

    const runs = await withRlsContext(db, { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (trx) =>
      trx.selectFrom('qc_runs').selectAll().where('task_id', '=', taskId).execute()
    );
    expect(runs).toHaveLength(1);
    const run: any = runs[0];
    expect(run.status).toBe('failed');
    expect(run.critical_pass).toBe(false);
    expect(run.report.criticalPass).toBe(false);
    // The hash is of the report as Core serialized it (Postgres jsonb does not keep key order, so it cannot
    // be recomputed from the stored column). It is the same hash the review desk shows for this revision.
    expect(run.report_sha256).toMatch(/^[0-9a-f]{64}$/);
    const desk = await (await app.request(`/tasks/${taskId}/review-desk`, { headers: auth })).json();
    expect(desk.qaEvidence.qcReportHash).toBe(run.report_sha256);
    await db.destroy();
  });
});
