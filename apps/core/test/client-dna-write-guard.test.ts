import { describe, expect, it } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Bug hunt 3: the client DNA write routes had no role check (row-level security was the only guard,
 * and there is none without a database), took `expectedVersion` as optional, and rolled back without
 * one. Every write now needs an office role allowed to edit DNA and the version it changes.
 */
describe('client DNA writes need a DNA-editing role and the version they change', () => {
  const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'art_director' }, roleHeader: true } });
  const as = (role: string) => ({ 'Content-Type': 'application/json', 'x-user-role': role });
  const current = async () => (await (await app.request('/v1/clients/client-aster/dna', { headers: as('art_director') })).json()) as { version: number } & Record<string, unknown>;

  it('refuses roles that may not edit DNA on every write route', async () => {
    const dna = await current();
    for (const role of ['requester', 'auditor', 'language_reviewer', 'approver', 'model_evaluator']) {
      const save = await app.request('/v1/clients/client-aster/dna', { method: 'POST', headers: as(role), body: JSON.stringify({ ...dna, expectedVersion: dna.version }) });
      expect(save.status, `${role} save`).toBe(403);
      const snap = await app.request('/v1/clients/client-aster/snapshots', { method: 'POST', headers: as(role), body: JSON.stringify({ commitMessage: 'x', expectedVersion: dna.version }) });
      expect(snap.status, `${role} snapshot`).toBe(403);
      const back = await app.request('/v1/clients/client-aster/dna/rollback', { method: 'POST', headers: as(role), body: JSON.stringify({ targetVersion: 11, expectedVersion: dna.version }) });
      expect(back.status, `${role} rollback`).toBe(403);
    }
    expect((await current()).version).toBe(dna.version);
  });

  it('requires an integer expectedVersion and answers 409 on a stale or loosely equal one', async () => {
    const dna = await current();
    const { version: _v, ...body } = dna;
    for (const [route, payload] of [
      ['/dna', body],
      ['/snapshots', { commitMessage: 'Governance snapshot' }],
      ['/dna/rollback', { targetVersion: 11, reason: 'Wrong palette' }],
    ] as const) {
      const missing = await app.request(`/v1/clients/client-aster${route}`, { method: 'POST', headers: as('administrator'), body: JSON.stringify(payload) });
      expect(missing.status, `${route} without expectedVersion`).toBe(400);
      const loose = await app.request(`/v1/clients/client-aster${route}`, { method: 'POST', headers: as('administrator'), body: JSON.stringify({ ...payload, expectedVersion: String(dna.version) }) });
      expect(loose.status, `${route} with a string version`).toBe(400);
      const stale = await app.request(`/v1/clients/client-aster${route}`, { method: 'POST', headers: as('administrator'), body: JSON.stringify({ ...payload, expectedVersion: dna.version - 1 }) });
      expect(stale.status, `${route} stale`).toBe(409);
    }
    expect((await current()).version).toBe(dna.version);
  });

  it('keeps the Desk DNA screen working: save, snapshot and rollback with the version read', async () => {
    let dna = await current();
    const saved = await app.request('/v1/clients/client-aster/dna', { method: 'POST', headers: as('administrator'), body: JSON.stringify({ ...dna, expectedVersion: dna.version }) });
    expect(saved.status).toBe(201);
    dna = await current();
    const snap = await app.request('/v1/clients/client-aster/snapshots', { method: 'POST', headers: as('operator'), body: JSON.stringify({ commitMessage: 'Snapshot', expectedVersion: dna.version }) });
    expect(snap.status).toBe(201);
    dna = await current();
    const back = await app.request('/v1/clients/client-aster/dna/rollback', { method: 'POST', headers: as('art_director'), body: JSON.stringify({ targetVersion: 11, reason: 'Back', expectedVersion: dna.version }) });
    expect(back.status).toBe(200);
    expect((await back.json()).activeVersion).toBe(dna.version + 1);
  });
});
