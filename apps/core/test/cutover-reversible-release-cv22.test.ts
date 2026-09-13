import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('CV-22 / NFR-025: cutover claims require evidence', () => {
  it('distinguishes selected Canva studio from verified cloud connectivity', async () => {
    const response = await createApp().request('/system/studio-status');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.activeStudio).toBe('canva');
    expect(body.cloudConnected).toBe(false);
    expect(body.admittedClients).toEqual([]);
    expect(body.qualification).toBe('not_verified');
  });
  it('never supplies invented pilot counts, signoffs or release qualification', async () => {
    const body = await (await createApp().request('/system/cutover/status')).json();
    expect(body.cutoverState).toBe('NOT_QUALIFIED');
    expect(body.pilotSignoff).toBeNull();
    expect(body.dataCounts).toBeNull();
    expect(body.activeStudio.cloudConnected).toBe(false);
  });
  it('does not mistake comparing a local list with itself for a recovery drill', async () => {
    const response = await createApp().request('/system/cutover/rollback-rehearsal', { method: 'POST', headers: { Authorization: 'Bearer test_bearer' } });
    expect(response.status).toBe(422);
    expect((await response.json()).title).toBe('Recovery Drill Required');
  });
  it('cannot obtain a default Canva link without authenticated task scope', async () => {
    const response = await createApp().request('/v1/tasks/00000000-0000-4000-a000-000000000001/editor-url', { headers: { 'x-enforce-auth': 'true' } });
    expect(response.status).toBe(401);
  });
  it('will not accept a volatile binding when PostgreSQL is unavailable', async () => {
    const response = await createApp().request('/v1/tasks/00000000-0000-4000-a000-000000000001/canva-binding', {
      method: 'POST', headers: { Authorization: 'Bearer test_bearer', 'Content-Type': 'application/json' },
      body: JSON.stringify({ editUrl: 'https://www.canva.com/design/DAexample/edit' }),
    });
    expect(response.status).toBe(503);
  });
});
