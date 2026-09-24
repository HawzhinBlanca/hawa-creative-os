import crypto from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * Group G1 of the app.ts split, second step (architecture programme 1.3, SPLIT_PLAN.md section 7):
 * the leaves keep nothing a restart would lose, and no longer fall back to a fixture client.
 */
const TENANT = '00000000-0000-4000-a000-000000000001';
const OPERATOR = '00000000-0000-4000-b000-000000000001';
const bearer = { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const json = { 'Content-Type': 'application/json' };

describe('G1: the Telegram Mini App session survives a restart', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => db.destroy());
  afterEach(() => vi.unstubAllEnvs());

  /** initData signed the way Telegram signs it (core.telegram.org/bots/webapps). */
  function signedInitData(botToken: string, userId: number): string {
    const params = new URLSearchParams();
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('query_id', 'AAG1leaves');
    params.set('user', JSON.stringify({ id: userId, first_name: 'Office' }));
    const entries: string[] = [];
    params.forEach((v, k) => entries.push(`${k}=${v}`));
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(entries.sort().join('\n')).digest('hex'));
    return params.toString();
  }

  it('a token issued by one Core is accepted by the next one', async () => {
    const botToken = ['12345', 'g1leavesfixture'].join(':');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', botToken);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '7001');

    const res = await createApp({ db }).request('/v1/auth/telegram-miniapp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ initData: signedInitData(botToken, 7001) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; durable?: boolean };
    expect(body.durable).toBe(true);

    // The session lived only in the issuing process's map: a restart (or a second Core) signed
    // the office member out.
    const next = await createApp({ db }).request('/v1/auth/session', { headers: { Authorization: `Bearer ${body.sessionToken}` } });
    expect(next.status).toBe(200);
    expect(((await next.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });
});

describe('G1: the rubric scorer keeps no reports in memory', () => {
  const nodes = [{ id: 'headline', role: 'headline', text: 'Hawa', x: 100, y: 300, width: 880, height: 120, fontSize: 48, color: '#FFFFFF', background: '#0F172A' }];

  it('answers GET rubric-reports with 410: nothing is stored, the scorer returns each report to its caller', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' } } });
    const res = await app.request(`/v1/tasks/${crypto.randomUUID()}/rubric-reports`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { detail: string }).detail).toContain('not stored');
  });

  it('refuses to score a task that names no client instead of scoring it as a fixture office', async () => {
    const db = createDb(process.env.TEST_DATABASE_URL!);
    try {
      const taskId = crypto.randomUUID();
      await withRlsContext(db, { tenantId: TENANT, userId: OPERATOR, role: 'operator' }, (trx) =>
        sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title) VALUES (${taskId}::uuid, ${TENANT}::uuid, NULL, 'G1 rubric without a client')`.execute(trx));
      const res = await createApp({ db }).request(`/v1/tasks/${taskId}/revisions/rev-g1/evaluate-rubric`, {
        method: 'POST',
        headers: { ...json, ...bearer },
        body: JSON.stringify({ nodes }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { title: string }).title).toBe('CLIENT_REQUIRED');
    } finally {
      await db.destroy();
    }
  });
});

describe('G1: an uploaded asset names its client', () => {
  it('refuses an upload without a client instead of filing it under a fixture office', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' } } });
    const res = await app.request('/v1/assets/upload', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ filename: 'logo.png', mimeType: 'image/png', content: 'png-bytes' }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { title: string }).title).toBe('CLIENT_REQUIRED');
    const list = (await (await app.request('/v1/assets')).json()) as unknown[];
    expect(list).toEqual([]);
  });
});
