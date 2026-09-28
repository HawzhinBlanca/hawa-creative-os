/**
 * The arithmetic of the load test (scripts/load/run.ts): what a Desk tab asked Core for, how long a
 * brief took to become a draft, and what Core's own logs say. Pure functions, so the numbers the
 * report prints are tested (scripts/load/test/load-stats.test.ts) rather than trusted.
 */

/** One request a simulated Desk tab made, as its fetch saw it. */
export interface TabRequest {
  tab: string;
  /** Epoch ms when the request started (the load test's own clock). */
  at: number;
  method: string;
  /** `routeOf` of the path: no ids, no query (a stream ticket never reaches the report). */
  route: string;
  /** 0 when the request never got an answer. */
  status: number;
  /** Until the whole body was read. */
  ms: number;
  bytes: number;
  /** For `GET /v1/tasks`: the queue page it read (1 = newest), when the tab knew the cursor. */
  page?: number | null;
  error?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `GET /v1/tasks/:id/timeline` for `GET /v1/tasks/<uuid>/timeline?x=1`. */
export function routeOf(method: string, path: string): string {
  const pathname = path.split('?')[0].replace(UUID, ':id');
  return `${method.toUpperCase()} ${pathname}`;
}

/** Linear interpolation between the two nearest ranks; null for no samples (never a made-up 0). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(2));
}

export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function summarise(values: readonly number[]): Summary {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Number(Math.max(...values).toFixed(2)) : null,
  };
}

/** The parts of the fake Telegram's records this file reads (packages/testkit/chaos/fakes/telegram.ts). */
export interface PollRecord {
  at: string;
  offset: number;
  returned: number[];
}
export interface SentRecord {
  method: string;
  chat_id: string;
  at: string;
  delivered: boolean;
  replyMarkup: unknown;
}

/** A draft is the message that carries the requester's approve button (rq:ok:), as the chaos driver reads it. */
export function isDraftSend(s: SentRecord): boolean {
  return s.delivered && s.method === 'sendMessage' && /rq:ok:/.test(JSON.stringify(s.replyMarkup ?? ''));
}

export interface DraftLatency {
  chat: string;
  updateId: number;
  /** When the bot's getUpdates first returned the brief (the fake's clock). */
  pickedUpAt: number | null;
  /** When the chat was first shown a draft (the fake's clock). */
  draftAt: number | null;
  fromPickupMs: number | null;
}

/**
 * Brief to first draft, both ends on the fake Telegram's clock: from the poll that first returned the
 * update (a real long poll returns at once; the fake's idle poll waits up to a second, which is not
 * the office's time) to the first draft the chat was shown.
 */
export function draftLatencies(input: { briefs: ReadonlyArray<{ chat: string; updateId: number }>; polls: readonly PollRecord[]; sent: readonly SentRecord[] }): DraftLatency[] {
  return input.briefs.map(({ chat, updateId }) => {
    const poll = input.polls.find((p) => p.returned.includes(updateId));
    const draft = input.sent.find((s) => s.chat_id === chat && isDraftSend(s));
    const pickedUpAt = poll ? Date.parse(poll.at) : null;
    const draftAt = draft ? Date.parse(draft.at) : null;
    return { chat, updateId, pickedUpAt, draftAt, fromPickupMs: pickedUpAt !== null && draftAt !== null ? draftAt - pickedUpAt : null };
  });
}

export interface TabRate {
  requests: number;
  perMinute: number;
  byRoute: Record<string, number>;
  /** `GET /v1/tasks` per minute: the programme's measure (0.3: at most 2 a minute for an idle tab). */
  listPerMinute: number;
}

/** Requests each tab started inside [from, to), per minute, by route. Tabs with none still appear. */
export function requestRates(records: readonly TabRequest[], window: { from: number; to: number }, tabs: readonly string[]): Record<string, TabRate> {
  const minutes = (window.to - window.from) / 60_000;
  const out: Record<string, TabRate> = {};
  for (const tab of tabs) {
    const mine = records.filter((r) => r.tab === tab && r.at >= window.from && r.at < window.to);
    const byRoute: Record<string, number> = {};
    for (const r of mine) byRoute[r.route] = (byRoute[r.route] || 0) + 1;
    const list = mine.filter((r) => r.route === 'GET /v1/tasks').length;
    out[tab] = {
      requests: mine.length,
      perMinute: minutes > 0 ? Number((mine.length / minutes).toFixed(2)) : 0,
      byRoute: Object.fromEntries(Object.entries(byRoute).sort(([a], [b]) => a.localeCompare(b))),
      listPerMinute: minutes > 0 ? Number((list / minutes).toFixed(2)) : 0,
    };
  }
  return out;
}

/**
 * Which queue page a `GET /v1/tasks` read: page 1 has no cursor, and each answer's `nextCursor`
 * starts the page after it. A cursor this tab never received is not guessed.
 */
export class PageTracker {
  private readonly pageOfCursor = new Map<string, number>();

  private static list(path: string): URLSearchParams | null {
    const [pathname, query = ''] = path.split('?');
    return pathname === '/v1/tasks' ? new URLSearchParams(query) : null;
  }

  pageOf(path: string): number | null {
    const params = PageTracker.list(path);
    if (!params) return null;
    const cursor = params.get('cursor');
    return cursor ? this.pageOfCursor.get(cursor) ?? null : 1;
  }

  learn(path: string, body: unknown): void {
    const page = this.pageOf(path);
    const next = (body as { nextCursor?: unknown } | null)?.nextCursor;
    if (page !== null && typeof next === 'string' && next) this.pageOfCursor.set(next, page + 1);
  }
}

export interface CoreRequestLine {
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // A line cut by the log driver, or text: not a request line.
    }
  }
  return out;
}

/** Core's `request` lines (apps/core/src/logging.ts): method, path, status and handler time. */
export function parseCoreRequestLines(text: string): CoreRequestLine[] {
  return jsonLines(text)
    .filter((l) => l.msg === 'request' && typeof l.path === 'string' && typeof l.ms === 'number')
    .map((l) => ({ at: Date.parse(String(l.time ?? '')), method: String(l.method ?? ''), path: String(l.path), status: Number(l.status ?? 0), ms: Number(l.ms) }));
}

/** Lines logged at error or fatal, with the first few messages (cut to 200 characters). */
export function errorLines(text: string, keep = 5): { count: number; samples: string[] } {
  const bad = jsonLines(text).filter((l) => l.level === 'error' || l.level === 'fatal');
  return { count: bad.length, samples: bad.slice(0, keep).map((l) => `${String(l.level)}: ${String(l.msg ?? '').slice(0, 200)}`) };
}

/**
 * The load test seeds and reads the chaos database only: 127.0.0.1:56432, database hawa_chaos
 * (packages/testkit/chaos/docker-compose.chaos.yml). Anything else, the office's server above all,
 * is refused before a connection is made.
 */
export function assertChaosDatabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('the load test takes a postgresql:// URL of the chaos database');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '56432' || database !== 'hawa_chaos') {
    throw new Error(`refused: the load test writes only to the chaos database (127.0.0.1:56432/hawa_chaos), not ${parsed.hostname}:${parsed.port}/${database}`);
  }
}
