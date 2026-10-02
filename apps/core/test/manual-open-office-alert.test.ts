import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { projectLifecycleOpen } from '../src/services/lifecycle-projection.js';

/**
 * 2026-10-02 (reality check): a request opened for a designer told the requester "A designer will make …"
 * and alerted nobody; it waited in the Desk until the 24-hour stale sweep (the canary chat's "Spring Concert"
 * showed one requester message and no office line). The office now hears at once, with the reason.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());
const tenantId = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const OFFICE = ['91500021', '91500022'];

function open(opts: { clientId: string | null; autoGenerate: boolean; title: string }) {
  vi.stubEnv('TELEGRAM_ALLOWED_USERS', OFFICE.join(','));
  const requestId = randomUUID();
  return projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(68_000_000 + Math.floor(Math.random() * 8_000_000)),
      rawText: opts.title, title: opts.title, designInstructions: '', exactCopy: [opts.title], clientId: opts.clientId,
      autoGenerate: opts.autoGenerate, designStudio: false } as any,
  });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('a request opened for a designer alerts the office at once', () => {
  it('names the design, the client and why nothing was drafted, for every office member', async () => {
    const r = await open({ clientId: KAAE, autoGenerate: false, title: 'Autumn Fair poster' });
    expect(r.stage).toBe('manual');
    expect(r.officeAlerts?.map((a) => a.chatId)).toEqual(OFFICE);
    const text = r.officeAlerts![0].text;
    expect(text).toContain('A new request needs a designer: "Autumn Fair poster" for Kurdistan Accrediting Association for Education.');
    expect(text).toContain('Nothing was drafted automatically (automatic drafts are off for this client)');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('says when no organisation was named', async () => {
    const r = await open({ clientId: null, autoGenerate: false, title: 'A poster for our open day' });
    expect(r.officeAlerts?.[0].text).toContain('no organisation was named');
  });

  it('a request drafted automatically sends no such alert (the draft alert follows it)', async () => {
    const r = await open({ clientId: KAAE, autoGenerate: true, title: 'Winter Bazaar poster' });
    expect(r.stage).toBe('designing');
    expect(r.officeAlerts).toBeUndefined();
  });
});

// 2026-10-02: the one delivered design waited 15 h overnight for approval; the review reminder was 24 h.
import { STALE_AFTER_MS, staleAlertText } from '../src/services/lifecycle-stale-sweep.js';
describe('the office is reminded within hours, once per stage', () => {
  it('a draft in review after 2 hours, a request for a designer after 8', () => {
    expect(STALE_AFTER_MS.in_review).toBe(2 * 60 * 60_000);
    expect(STALE_AFTER_MS.manual).toBe(8 * 60 * 60_000);
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(staleAlertText({ requestId: 'r', taskId: 't', stage: 'in_review', rev: 2, waitingSinceMs: now - 2 * 60 * 60_000 - 60_000 }, now))
      .toContain('has waited for its office review for 2 hours');
  });
});
