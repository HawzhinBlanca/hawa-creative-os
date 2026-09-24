import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * Architecture programme 0.3 (2026-09-24): GET /tasks pages on the server. The Desk read every page
 * of it every 30 s and after every task event; each page ran six correlated subqueries per row and
 * carried the intake event's JSON, a reference photo included. Now: keyset pages with an opaque
 * cursor, a limit (default 50, at most 200), the filter's total, filters and search done by Core,
 * and rows without the intake JSON. `offset` and `status` keep working for older callers.
 * Runs against hawa-test-postgres as hawa_app (row-level security as in production).
 */
describe('GET /tasks pages (PostgreSQL)', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  const marker = `listpage${randomUUID().slice(0, 8)}`;
  const created: string[] = [];
  let app: ReturnType<typeof createApp>;
  // A reference photo as a request can carry one: it must never come back in a list row.
  const photo = `data:image/jpeg;base64,${Buffer.alloc(60_000, 7).toString('base64')}`;

  beforeAll(async () => {
    app = createApp({ db } as any);
    for (let i = 0; i < 7; i++) {
      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: operator,
        body: JSON.stringify({
          title: `Members evening ${marker} #${i}`,
          description: 'Erbil, December',
          headlineCkb: `ئێوارەی ئەندامان ${i}`,
          designInstructions: 'Logo top right',
          referencePhoto: photo,
          idempotencyKey: `${marker}-${i}`,
        }),
      });
      expect(res.status).toBeLessThan(300);
      created.unshift((await res.json()).id); // newest first
    }
  }, 60_000);
  afterAll(() => db.destroy());

  const list = async (query: string) => {
    const res = await app.request(`/v1/tasks?${query}`, { headers: operator });
    return { status: res.status, body: await res.json(), text: '' };
  };

  it('pages by cursor: a limit per page, the total, each task once, newest first, and no next cursor on the last page', async () => {
    const ids: string[] = [];
    const pages: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(`q=${marker}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(7);
      expect(res.body.limit).toBe(3);
      pages.push(res.body.items.length);
      ids.push(...res.body.items.map((t: any) => t.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(pages).toEqual([3, 3, 1]);
    expect(ids).toEqual(created);
  });

  it('keeps offset paging for callers that send it', async () => {
    const res = await list(`q=${marker}&limit=3&offset=3`);
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(3);
    expect(res.body.items.map((t: any) => t.id)).toEqual(created.slice(3, 6));
  });

  it('defaults to 50 rows and caps a page at 200', async () => {
    expect((await list('')).body.limit).toBe(50);
    expect((await list('limit=5000')).body.limit).toBe(200);
    expect((await list('limit=5000')).body.items.length).toBeLessThanOrEqual(200);
  });

  it('filters by the Desk\'s statuses and by the older single status', async () => {
    expect((await list(`q=${marker}&statuses=RECEIVED,AWAITING_APPROVAL`)).body.total).toBe(7);
    expect((await list(`q=${marker}&statuses=COMPLETE`)).body.total).toBe(0);
    expect((await list(`q=${marker}&status=RECEIVED`)).body.total).toBe(7);
  });

  it('list rows carry the text the queue shows but no intake JSON and no image', async () => {
    const res = await app.request(`/v1/tasks?q=${marker}&limit=7`, { headers: operator });
    const text = await res.text();
    expect(text).not.toContain('data:image');
    expect(text).not.toContain(photo.slice(30, 90));
    const items = JSON.parse(text).items;
    expect(items[0]).not.toHaveProperty('intake_data');
    expect(items[0].headlineCkb).toMatch(/^ئێوارەی ئەندامان/);
    expect(items[0].designInstructions).toBe('Logo top right');
    expect(items[0].sourcePlatform).toBe('hawa_desk');
    // A row is small: the photo alone is 80 kB of base64.
    expect(text.length).toBeLessThan(7 * 3_000);
  });

  // Architecture programme 1.5: Sorani is stored with ە (U+06D5) for the vowel and ی, ک; an Arabic
  // keyboard has none of the three and types ه (often with a zero-width non-joiner), ي and ك. The
  // title below is stored as the office writes it; each search is how it arrives from such a keyboard.
  it('finds a Kurdish title typed on an Arabic keyboard (ه for ە, ي for ی, ك for ک, a ZWNJ)', async () => {
    const title = `ئاهەنگی کۆلێژ ${marker}`;
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: operator,
      body: JSON.stringify({ title, description: 'Kurdish search', idempotencyKey: `${marker}-ckb` }),
    });
    expect(res.status).toBeLessThan(300);
    const id = (await res.json()).id;
    for (const typed of ['ئاهەنگی کۆلێژ', 'ئاهه‌نگي كۆلێژ', 'ئاههنگي', 'كۆلێژ']) {
      const found = await list(`q=${encodeURIComponent(typed)}&limit=200`);
      expect(found.status, typed).toBe(200);
      expect(found.body.items.map((t: any) => t.id), typed).toContain(id);
    }
    // Folding does not make everything match.
    expect((await list(`q=${encodeURIComponent(`ئاهەنگی کۆلێژ ${marker}x`)}`)).body.total).toBe(0);
  });

  it('refuses a cursor it did not issue and a client id that is not a UUID', async () => {
    expect((await list('cursor=bm90LWEtY3Vyc29y')).status).toBe(400);
    expect((await list('clientId=kaae')).status).toBe(400);
  });
});
