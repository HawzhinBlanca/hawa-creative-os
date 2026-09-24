import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';

/**
 * Safety nets for splitting app.ts into route modules (architecture programme 1.3, SPLIT_PLAN.md
 * section 5, N1 and N2). Every step of the split is meant to be a pure move, so what the router
 * serves, and which handler answers a URL two patterns both match, must not change unless a step
 * says so. These ask the router itself (`app.routes`, in registration order), not app.ts's text,
 * so they hold wherever a route ends up living.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(here, 'fixtures/route-inventory.txt');
const PREFIXES = ['/api/v1', '/v1', '/api'];

type Route = { method: string; path: string };

/** Every route handler in registration order; the `app.use('*')` middleware is not a route. */
function routeTable(): Route[] {
  const app = createApp() as unknown as { routes: Route[] };
  return app.routes.filter((r) => !(r.method === 'ALL' && (r.path === '/*' || r.path === '*')));
}

const bare = (p: string) => {
  for (const prefix of PREFIXES) if (p === prefix || p.startsWith(`${prefix}/`)) return p.slice(prefix.length) || '/';
  return p;
};

/**
 * Whether one URL can match both patterns. A `:param` segment (with or without a `{regex}`) is
 * taken to match anything, which can only over-report; a trailing `*` matches the rest of the path.
 */
function canMatchSameUrl(a: string, b: string): boolean {
  const split = (p: string) => p.split('/').filter(Boolean);
  const x = split(a);
  const y = split(b);
  const wildX = x[x.length - 1] === '*';
  const wildY = y[y.length - 1] === '*';
  const headX = wildX ? x.slice(0, -1) : x;
  const headY = wildY ? y.slice(0, -1) : y;
  if (!wildX && !wildY && headX.length !== headY.length) return false;
  if (wildX && !wildY && headY.length < headX.length) return false;
  if (wildY && !wildX && headX.length < headY.length) return false;
  const isParam = (s: string) => s.startsWith(':');
  for (let i = 0; i < Math.min(headX.length, headY.length); i++) {
    if (headX[i] !== headY[i] && !isParam(headX[i]) && !isParam(headY[i])) return false;
  }
  return true;
}

describe('N1: the route inventory', () => {
  // A move that drops, renames or re-prefixes a route changes this list. So does a new route: add it
  // to the file in the same change (HAWA_UPDATE_ROUTE_INVENTORY=1 rewrites it), so the diff shows it.
  it('serves exactly the routes in fixtures/route-inventory.txt', () => {
    const served = [...new Set(routeTable().map((r) => `${r.method} ${r.path}`))].sort();
    // Guards against the router no longer exposing its table, which would make this pass on nothing.
    expect(served.length).toBeGreaterThan(600);
    if (process.env.HAWA_UPDATE_ROUTE_INVENTORY === '1') fs.writeFileSync(INVENTORY, `${served.join('\n')}\n`);
    const recorded = fs.readFileSync(INVENTORY, 'utf8').split('\n').filter(Boolean);
    const missing = recorded.filter((r) => !served.includes(r));
    const added = served.filter((r) => !recorded.includes(r));
    expect({ missing, added }).toEqual({ missing: [], added: [] });
  });

  it('mounts every route registered through registerRoute under all four prefixes', () => {
    const served = new Set(routeTable().map((r) => `${r.method} ${r.path}`));
    const incomplete: string[] = [];
    for (const r of routeTable()) {
      if (!r.path.startsWith('/api/v1/')) continue;
      const tail = r.path.slice('/api/v1'.length);
      for (const p of ['/v1', '/api', '']) if (!served.has(`${r.method} ${p}${tail}`)) incomplete.push(`${r.method} ${p}${tail}`);
    }
    expect(incomplete).toEqual([]);
  });
});

describe('N2: route order', () => {
  /**
   * Pairs of routes of one method where a URL can match both, as `earlier -> later` (bare paths).
   * Hono runs the handlers that match a URL in registration order and the first one to answer wins,
   * so for each pair the later route is reached only if the earlier one calls next(). A move that
   * changes registration order changes which handler answers; a new overlap has to be listed here,
   * with its reason, before it is accepted.
   */
  const ALLOWED: Record<string, string> = {
    // The `:control` catch-all answers 404 for an unknown task before it checks the control word,
    // and calls next() for words other than pause/resume/cancel/retry. SPLIT_PLAN F9 replaces it with
    // four explicit paths, which removes all thirteen pairs.
    'POST /tasks/:taskId/briefs -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/canva-binding -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/design-feedback -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/generate -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/leases -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/publish -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/route -> /tasks/:taskId/:control': 'catch-all, registered after (F9 removes)',
    'POST /tasks/:taskId/:control -> /tasks/:taskId/chat-approval-action': 'intercepted by the catch-all (F9 removes)',
    'POST /tasks/:taskId/:control -> /tasks/:taskId/comments': 'intercepted by the catch-all (F9 removes)',
    'POST /tasks/:taskId/:control -> /tasks/:taskId/feedback': 'intercepted by the catch-all (F9 removes)',
    'POST /tasks/:taskId/:control -> /tasks/:taskId/publish-omnichannel': 'intercepted by the catch-all (F9 removes)',
    'POST /tasks/:taskId/:control -> /tasks/:taskId/redrive': 'intercepted by the catch-all (F9 removes)',
    'POST /tasks/:taskId/:control -> /tasks/:taskId/revisions': 'intercepted by the catch-all (F9 removes)',
    // The one order that must survive the split: `diff` is a word, not a revision id.
    'GET /tasks/:taskId/revisions/diff -> /tasks/:taskId/revisions/:revisionId': 'diff must stay first (revisions module)',
    // The Figma tombstone registers both `/figma/status` and `/v1/figma/status`, so `/v1/figma/status`
    // is mounted twice; both are the same 410 handler.
    'GET /figma/status -> /figma/status': 'same tombstone handler twice',
  };

  it('has only the overlaps listed, each for its stated reason', () => {
    const routes = routeTable();
    const found = new Set<string>();
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const [a, b] = [routes[i], routes[j]];
        if (a.method === b.method && canMatchSameUrl(a.path, b.path)) found.add(`${a.method} ${bare(a.path)} -> ${bare(b.path)}`);
      }
    }
    expect([...found].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('registers revisions/diff before revisions/:revisionId under every prefix', () => {
    const order = routeTable().filter((r) => r.method === 'GET').map((r) => r.path);
    for (const prefix of ['/api/v1', '/v1', '/api', '']) {
      const diff = order.indexOf(`${prefix}/tasks/:taskId/revisions/diff`);
      const byId = order.indexOf(`${prefix}/tasks/:taskId/revisions/:revisionId`);
      expect(diff, prefix || '(bare)').toBeGreaterThan(-1);
      expect(diff, prefix || '(bare)').toBeLessThan(byId);
    }
  });

  /**
   * A route module, service or fixture file that imports app.ts is a cycle: app.ts imports the
   * module to register or seed from it. Two exist today because app.ts still exports helpers they need; SPLIT_PLAN F1 moves those
   * helpers to core-helpers.ts and empties this list. Nothing may be added to it.
   */
  const IMPORTS_APP_TODAY = ['routes/canva.routes.ts', 'routes/system.routes.ts'];

  it('has no module under src/routes, src/services or src/fixtures importing app.js, beyond the two F1 removes', () => {
    const src = path.join(here, '../src');
    const importsApp = /(?:from\s+|import\s*\(\s*)['"](?:\.\.?\/)+app(?:\.js)?['"]/;
    const offenders: string[] = [];
    for (const dir of ['routes', 'services', 'fixtures']) {
      for (const file of fs.readdirSync(path.join(src, dir), { recursive: true }).map(String)) {
        if (!/\.tsx?$/.test(file)) continue;
        if (importsApp.test(fs.readFileSync(path.join(src, dir, file), 'utf8'))) offenders.push(`${dir}/${file.split(path.sep).join('/')}`);
      }
    }
    expect(offenders.sort()).toEqual(IMPORTS_APP_TODAY);
  });
});
