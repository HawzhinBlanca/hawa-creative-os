import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Bug hunt 3: POST /ingress/unified took any signed-in role, recorded every relayed message as
 * verified and accepted any number of attachments. It has no production caller (the WhatsApp and
 * Telegram adapters reach the service, not this route); the office relays through it.
 */
const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });
const as = (role: string, body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-user-role': role },
  body: JSON.stringify(body),
});
const message = (extra: Record<string, unknown> = {}) => {
  const id = randomUUID();
  return { channel: 'telegram', sourceAccountId: 'office_main_bot', sourceEventId: `evt_${id}`, sourceMessageId: `msg_${id}`,
    senderExternalId: 'relay', text: 'A note for the office', rawPayload: { id }, ...extra };
};
const attachment = (n: number, byteSize = 1024) => ({ filename: `photo${n}.jpg`, mimeType: 'image/jpeg', byteSize });

describe('POST /ingress/unified (bug hunt 3)', () => {
  it.each(['requester', 'auditor', 'designer', 'language_reviewer', 'approver', 'art_director'])('refuses the %s role', async (role) => {
    const res = await app.request('/v1/ingress/unified', as(role, message()));
    expect(res.status).toBe(403);
  });

  it('accepts the operator and administrator roles, and records the relayed message as unverified', async () => {
    for (const role of ['operator', 'administrator']) {
      const res = await app.request('/v1/ingress/unified', as(role, message({ verified: true })));
      expect(res.status, role).toBe(201);
      const body = await res.json();
      // The route authenticates the relaying office, not the channel the message claims to come from.
      expect(body.normalizedEnvelope.verification).toEqual({ verified: false, method: 'office_api_relay' });
    }
  });

  it('caps the attachment count and declared sizes', async () => {
    const many = await app.request('/v1/ingress/unified', as('operator', message({ attachments: Array.from({ length: 11 }, (_, i) => attachment(i)) })));
    expect(many.status).toBe(413);
    const huge = await app.request('/v1/ingress/unified', as('operator', message({ attachments: [attachment(1, 60 * 1024 * 1024)] })));
    expect(huge.status).toBe(413);
    const total = await app.request('/v1/ingress/unified', as('operator', message({ attachments: Array.from({ length: 3 }, (_, i) => attachment(i, 45 * 1024 * 1024)) })));
    expect(total.status).toBe(413);
    for (const bad of [{ filename: 'x.jpg' }, 'x', { ...attachment(1), byteSize: -1 }]) {
      const res = await app.request('/v1/ingress/unified', as('operator', message({ attachments: [bad] })));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await app.request('/v1/ingress/unified', as('operator', message({ attachments: 'x' })))).status).toBe(400);
    const ok = await app.request('/v1/ingress/unified', as('operator', message({ attachments: Array.from({ length: 10 }, (_, i) => attachment(i)) })));
    expect(ok.status).toBe(201);
  });
});
