import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

/**
 * An approval names the QA report it relied on by that report's hash. With no report it used to
 * record the literal 'verified_qc_pass', and the review desk showed a passed, critical-pass QA run
 * with a random id. Now there is no hash, and the evidence says the QA did not run.
 */

const json = { 'Content-Type': 'application/json' };
const auth = { ...json, Authorization: 'Bearer test_bearer' };
const HEX64 = /^[0-9a-f]{64}$/;

function approve(app: ReturnType<typeof createApp>, taskId: string, revisionId: string, extra: Record<string, unknown> = {}) {
  return app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ decision: 'approved', role: 'art_director', ...extra }),
  });
}

describe('an approval without a QA report', () => {
  it('records no QC hash, and the review desk says QA did not run', async () => {
    const app = createApp();
    const created = await (await app.request('/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'No QA', clientId: 'c1000000-0000-4000-8000-000000000002' }) })).json();
    const taskId: string = created.id || created.task?.id;
    const rev = await (
      await app.request(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'No QA' }] } }),
      })
    ).json();

    const desk = await (await app.request(`/tasks/${taskId}/review-desk`, { headers: auth })).json();
    expect(desk.qaEvidence).toEqual({
      qcRunId: null,
      status: 'not_run',
      criticalPass: null,
      qcReportHash: null,
      findingsCount: 0,
      glyphCoveragePass: null,
      unobservedLayersCount: null,
    });

    const res = await approve(app, taskId, rev.revisionId);
    expect(res.status).toBe(201);
    expect((await res.json()).qcReportHash).toBeNull();
  });
});

describe('an approval after QA ran', () => {
  it('records the report\'s own SHA-256, the same one the review desk shows and the approval may echo back', async () => {
    const app = createApp();
    const created = await (await app.request('/v1/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'With QA' }) })).json();
    const taskId: string = created.id;
    await app.request(`/v1/tasks/${taskId}/route`, { method: 'POST', headers: json, body: JSON.stringify({ clientId: 'client-office-1', reason: 'Client assigned' }) });
    await app.request(`/v1/tasks/${taskId}/briefs`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ objective: 'Promo', rawRequestText: 'داشکاندنی ٢٥٪ تا ١٠ی مانگ', primaryLanguage: 'ckb', direction: 'rtl' }),
    });
    expect((await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' })).status).toBe(202);
    const { latestRevisionId } = await (await app.request(`/v1/tasks/${taskId}`)).json();

    const desk = await (await app.request(`/tasks/${taskId}/review-desk`, { headers: auth })).json();
    expect(desk.qaEvidence.qcReportHash).toMatch(HEX64);
    expect(desk.qaEvidence.status).toBe('passed');

    // A client echoing the hash it was shown is accepted (it used to be compared against a field the report lacks).
    const echoed = await approve(app, taskId, latestRevisionId, { qcReportHash: desk.qaEvidence.qcReportHash });
    expect(echoed.status).toBe(201);
    expect((await echoed.json()).qcReportHash).toBe(desk.qaEvidence.qcReportHash);
  });

  it('refuses an approval that echoes a different QC hash', async () => {
    const app = createApp();
    const created = await (await app.request('/v1/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Forged QA' }) })).json();
    const taskId: string = created.id;
    await app.request(`/v1/tasks/${taskId}/route`, { method: 'POST', headers: json, body: JSON.stringify({ clientId: 'client-office-1', reason: 'Client assigned' }) });
    await app.request(`/v1/tasks/${taskId}/briefs`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ objective: 'Promo', rawRequestText: 'داشکاندنی ٢٥٪ تا ١٠ی مانگ', primaryLanguage: 'ckb', direction: 'rtl' }),
    });
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });
    const { latestRevisionId } = await (await app.request(`/v1/tasks/${taskId}`)).json();

    const res = await approve(app, taskId, latestRevisionId, { qcReportHash: 'verified_qc_pass' });
    expect(res.status).toBe(422);
  });
});
