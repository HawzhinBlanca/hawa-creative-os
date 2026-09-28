import { describe, expect, it } from 'vitest';
import {
  assertChaosDatabaseUrl,
  draftLatencies,
  errorLines,
  isDraftSend,
  PageTracker,
  parseCoreRequestLines,
  percentile,
  requestRates,
  routeOf,
  summarise,
  type TabRequest,
} from '../load-stats.js';

const TASK = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('routeOf', () => {
  it('names a request by its route, with ids and the query left out', () => {
    expect(routeOf('GET', '/v1/tasks?limit=50&cursor=abc')).toBe('GET /v1/tasks');
    expect(routeOf('GET', `/v1/tasks/${TASK}`)).toBe('GET /v1/tasks/:id');
    expect(routeOf('GET', `/v1/tasks/${TASK}/timeline`)).toBe('GET /v1/tasks/:id/timeline');
    expect(routeOf('post', '/v1/auth/stream-ticket')).toBe('POST /v1/auth/stream-ticket');
    expect(routeOf('GET', `/v1/tasks/${TASK}/canva/artifacts/${TASK}`)).toBe('GET /v1/tasks/:id/canva/artifacts/:id');
  });
});

describe('percentile and summarise', () => {
  it('interpolates between the two nearest samples', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(9.55);
    expect(percentile([], 95)).toBeNull();
  });

  it('reports the count, p50, p95 and max', () => {
    expect(summarise([5, 1, 3])).toEqual({ n: 3, p50: 3, p95: 4.8, max: 5 });
    expect(summarise([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });
});

describe('draftLatencies', () => {
  const polls = [
    { at: '2026-09-24T10:00:00.500Z', offset: 0, returned: [] },
    { at: '2026-09-24T10:00:01.000Z', offset: 0, returned: [11, 12] },
    { at: '2026-09-24T10:00:02.000Z', offset: 13, returned: [11] },
  ];
  const draft = (chat: string, at: string, delivered = true) => ({
    method: 'sendMessage', chat_id: chat, at, delivered, replyMarkup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'rq:ok:abc' }]] },
  });
  const sent = [
    { method: 'sendMessage', chat_id: 'A', at: '2026-09-24T10:00:01.200Z', delivered: true, replyMarkup: null },
    draft('A', '2026-09-24T10:00:15.000Z', false),
    draft('A', '2026-09-24T10:00:16.000Z'),
    draft('A', '2026-09-24T10:00:30.000Z'),
  ];

  it('times each brief from the poll that first returned it to the first draft the chat was shown', () => {
    const [a, b] = draftLatencies({ briefs: [{ chat: 'A', updateId: 11 }, { chat: 'B', updateId: 12 }], polls, sent });
    expect(a).toMatchObject({ chat: 'A', updateId: 11, fromPickupMs: 15_000 });
    expect(a.pickedUpAt).toBe(Date.parse('2026-09-24T10:00:01.000Z'));
    expect(a.draftAt).toBe(Date.parse('2026-09-24T10:00:16.000Z'));
    // Chat B was picked up and never shown a draft: no time, not a zero.
    expect(b).toMatchObject({ chat: 'B', fromPickupMs: null, draftAt: null });
  });

  it('knows a draft by its approve button (rq:ok:), not by being a message', () => {
    expect(isDraftSend(sent[0])).toBe(false);
    expect(isDraftSend(sent[2])).toBe(true);
    expect(isDraftSend({ ...sent[2], delivered: false })).toBe(false);
  });
});

describe('requestRates', () => {
  const req = (tab: string, at: number, route: string): TabRequest => ({ tab, at, method: 'GET', route, status: 200, ms: 5, bytes: 10 });
  it('counts each tab\'s requests per minute inside a window, by route', () => {
    const from = 1_000_000;
    const records = [
      req('a', from - 1, 'GET /v1/tasks'),
      req('a', from + 1_000, 'GET /v1/health'),
      req('a', from + 31_000, 'GET /v1/health'),
      req('a', from + 61_000, 'GET /v1/health'),
      req('a', from + 90_000, 'GET /v1/tasks'),
      req('b', from + 5_000, 'GET /v1/health'),
      req('a', from + 120_001, 'GET /v1/tasks'),
    ];
    const rates = requestRates(records, { from, to: from + 120_000 }, ['a', 'b', 'c']);
    expect(rates.a).toEqual({ requests: 4, perMinute: 2, byRoute: { 'GET /v1/health': 3, 'GET /v1/tasks': 1 }, listPerMinute: 0.5 });
    expect(rates.b.perMinute).toBe(0.5);
    expect(rates.c).toEqual({ requests: 0, perMinute: 0, byRoute: {}, listPerMinute: 0 });
  });
});

describe('PageTracker', () => {
  it('numbers each list request by the cursor that started it', () => {
    const pages = new PageTracker();
    expect(pages.pageOf('/v1/tasks?limit=50')).toBe(1);
    pages.learn('/v1/tasks?limit=50', { items: [], total: 120, nextCursor: 'c2' });
    expect(pages.pageOf('/v1/tasks?limit=50&cursor=c2')).toBe(2);
    pages.learn('/v1/tasks?limit=50&cursor=c2', { items: [], total: 120, nextCursor: 'c3' });
    expect(pages.pageOf('/v1/tasks?cursor=c3&limit=50')).toBe(3);
    // A cursor it never saw (another tab's) is not guessed.
    expect(pages.pageOf('/v1/tasks?cursor=zz')).toBeNull();
    expect(pages.pageOf(`/v1/tasks/${TASK}`)).toBeNull();
  });
});

describe('Core log lines', () => {
  const text = [
    '{"level":"info","time":"2026-09-24T10:00:00.000Z","service":"core","requestId":"r1","method":"GET","path":"/v1/tasks","status":200,"ms":42,"msg":"request"}',
    '{"level":"info","time":"2026-09-24T10:00:00.100Z","service":"core","msg":"something else"}',
    'not json at all',
    '{"level":"error","time":"2026-09-24T10:00:01.000Z","service":"core","msg":"[outbox] handler failed: boom"}',
    '{"level":"fatal","time":"2026-09-24T10:00:02.000Z","service":"core","msg":"down"}',
    '{"level":"warn","time":"2026-09-24T10:00:03.000Z","service":"core","msg":"slow"}',
  ].join('\n');

  it('reads the request lines Core writes (apps/core/src/logging.ts)', () => {
    expect(parseCoreRequestLines(text)).toEqual([{ at: Date.parse('2026-09-24T10:00:00.000Z'), method: 'GET', path: '/v1/tasks', status: 200, ms: 42 }]);
  });

  it('counts error and fatal lines, with a few messages to look at', () => {
    expect(errorLines(text)).toEqual({ count: 2, samples: ['error: [outbox] handler failed: boom', 'fatal: down'] });
  });
});

describe('assertChaosDatabaseUrl', () => {
  it('accepts the chaos database only', () => {
    expect(() => assertChaosDatabaseUrl('postgresql://hawa_owner:x@127.0.0.1:56432/hawa_chaos')).not.toThrow();
    expect(() => assertChaosDatabaseUrl('postgresql://hawa_owner:x@127.0.0.1:54332/hawa_chaos')).toThrow(/chaos/);
    expect(() => assertChaosDatabaseUrl('postgresql://hawa_owner:x@127.0.0.1:56432/hawa')).toThrow(/chaos/);
    expect(() => assertChaosDatabaseUrl('postgresql://hawa_owner:x@10.0.0.5:56432/hawa_chaos')).toThrow(/chaos/);
    expect(() => assertChaosDatabaseUrl('not a url')).toThrow();
  });
});
