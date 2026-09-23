import crypto from 'node:crypto';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import {
  ComparisonError,
  addJudge,
  addPair,
  closeStudy,
  createStudy,
  decodeBase64Image,
  getStudy,
  isUuid,
  judgeImage,
  judgeNext,
  listStudies,
  lockStudy,
  readPairImage,
  recordJudgment,
  resolveJudge,
  revokeJudge,
  studyResults,
  type ComparisonScope,
  type JudgeSession,
} from '../services/comparison-study.js';
import { judgePageHtml, judgePagePolicy } from './judge-page.js';

/**
 * The blinded comparison of Hawa with the office's designer (services/comparison-study.ts).
 *
 * Office routes, behind the usual sign-in: an administrator, art director or creative director sets
 * up a study, its pairs and its judges, locks it, closes it and reads the results.
 *
 * Judge routes, under /judge/:token: the link's token is the only credential, so they are registered
 * outside the signed-in registrar (route-auth-enumeration.test.ts lists them as public, with why).
 * A malformed, unknown or revoked token answers 404 and nothing else, and no judge answer carries an
 * arm, a task, a label or a file name.
 */

const OFFICE_ROLES = ['administrator', 'art_director', 'creative_director'];
const JUDGE_PREFIXES = ['/api/v1', '/v1', '/api', ''];

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
};

type Body = Record<string, unknown>;
const bodyOf = async (c: Context): Promise<Body> => {
  const parsed: unknown = await c.req.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : {};
};

/** Where a judge's link points. HAWA_JUDGE_BASE_URL lets the office hand out an address judges outside can reach. */
export function judgeLink(token: string): { path: string; url: string | null } {
  const path = `/api/judge/${token}`;
  const base = (process.env.HAWA_JUDGE_BASE_URL || process.env.PUBLIC_TUNNEL_URL || process.env.HAWA_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return { path, url: base ? `${base}${path}` : null };
}

export function registerComparisonRoutes(ctx: RouteContext) {
  const { app, registerRoute, db, verifyRequestAuth, problem } = ctx;

  /** The office's scope, or a response refusing the caller. */
  const officeScope = (c: Context): ComparisonScope | Response => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId) return problem(c, 401, 'Authentication Required');
    if (!OFFICE_ROLES.includes(String(auth.role))) return problem(c, 403, 'Forbidden', 'Art director, creative director or administrator required');
    return { tenantId: auth.tenantId, userId: auth.userId, role: auth.role, actorId: auth.actorId };
  };

  const office = (handler: (c: Context, scope: ComparisonScope, database: NonNullable<typeof db>) => Promise<Response>) => async (c: Context) => {
    const scope = officeScope(c);
    if (scope instanceof Response) return scope;
    if (!db) return problem(c, 503, 'Database Unavailable', 'Comparison studies are kept in PostgreSQL');
    try {
      return await handler(c, scope, db);
    } catch (err) {
      if (err instanceof ComparisonError) return problem(c, err.status, TITLES[err.status] || 'Error', err.message);
      throw err;
    }
  };

  registerRoute('post', '/comparisons', office(async (c, scope, database) => {
    const body = await bodyOf(c);
    return c.json(await createStudy(database, scope, { name: body.name, preregistration: body.preregistration }), 201);
  }));

  registerRoute('get', '/comparisons', office(async (c, scope, database) => c.json({ studies: await listStudies(database, scope) })));

  registerRoute('get', '/comparisons/:id', office(async (c, scope, database) => c.json(await getStudy(database, scope, c.req.param('id') || ''))));

  // Hawa's design is uploaded, or taken from the task's final PNG export with fromTask; the
  // designer's is uploaded. Both are PNG only, sent as base64 in JSON like the Desk's other uploads.
  // Behind nginx a request body is capped at 25 MB, so the two images together must stay under ~18 MB.
  registerRoute('post', '/comparisons/:id/pairs', office(async (c, scope, database) => {
    const body = await bodyOf(c);
    const fromTask = body.fromTask === true;
    const pair = await addPair(database, scope, c.req.param('id') || '', {
      label: body.label,
      taskId: body.taskId,
      fromTask,
      hawaPng: fromTask || body.hawaPngBase64 === undefined ? undefined : decodeBase64Image(body.hawaPngBase64, "Hawa's design"),
      designerPng: body.designerPngBase64 === undefined ? undefined : decodeBase64Image(body.designerPngBase64, "designer's design"),
    });
    return c.json(pair, 201);
  }));

  // The token is shown here once. Hawa keeps only its SHA-256, so a lost link is replaced, not recovered.
  registerRoute('post', '/comparisons/:id/judges', office(async (c, scope, database) => {
    const body = await bodyOf(c);
    const { judge, token } = await addJudge(database, scope, c.req.param('id') || '', { name: body.name, kind: body.kind });
    c.header('Cache-Control', 'no-store');
    return c.json({ judge, token, link: judgeLink(token) }, 201);
  }));

  registerRoute('delete', '/comparisons/:id/judges/:judgeId', office(async (c, scope, database) =>
    c.json(await revokeJudge(database, scope, c.req.param('id') || '', c.req.param('judgeId') || ''))));

  registerRoute('post', '/comparisons/:id/lock', office(async (c, scope, database) => c.json(await lockStudy(database, scope, c.req.param('id') || ''))));

  registerRoute('post', '/comparisons/:id/close', office(async (c, scope, database) => c.json(await closeStudy(database, scope, c.req.param('id') || ''))));

  registerRoute('get', '/comparisons/:id/results', office(async (c, scope, database) => c.json(await studyResults(database, scope, c.req.param('id') || ''))));

  // The office's view of one arm: GET /comparisons/:id/pairs/:pairId/hawa.png or designer.png.
  registerRoute('get', '/comparisons/:id/pairs/:pairId/:file', office(async (c, scope, database) => {
    const file = c.req.param('file');
    const arm = file === 'hawa.png' ? 'hawa' : file === 'designer.png' ? 'designer' : null;
    if (!arm) return problem(c, 404, 'Not Found');
    const png = await readPairImage(database, scope, c.req.param('id') || '', c.req.param('pairId') || '', arm);
    if (!png) return problem(c, 404, 'Not Found');
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'private, no-store');
    return c.body(new Uint8Array(png), 200);
  }));

  // ---- Judge routes: the token in the path is the only credential. ----

  // A person opening a dead link reads a sentence; the page's own requests get JSON. Either way 404.
  const notFound = (c: Context, page = false) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if (page) {
      return c.html(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<meta name="robots" content="noindex, nofollow"><title>Link not active</title></head>' +
          '<body style="font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#eceef1;color:#1f2328">' +
          '<h1 style="font-size:20px">This link is not active</h1><p>Ask the office for a new link.</p></body></html>',
        404
      );
    }
    return c.json({ error: 'not_found' }, 404);
  };

  const judge = (handler: (c: Context, session: JudgeSession, database: NonNullable<typeof db>) => Promise<Response>, page = false) => async (c: Context) => {
    // Without a database there are no judges, and an unknown link must look like any other unknown link.
    if (!db) return notFound(c, page);
    const session = await resolveJudge(db, c.req.param('token') || '');
    if (!session) return notFound(c, page);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    try {
      return await handler(c, session, db);
    } catch (err) {
      if (err instanceof ComparisonError) return err.status === 404 ? notFound(c) : c.json({ error: err.message }, err.status);
      throw err;
    }
  };

  const onJudgePaths = (method: 'get' | 'post', path: string, handler: (c: Context) => Promise<Response>) => {
    for (const prefix of JUDGE_PREFIXES) {
      if (method === 'get') app.get(`${prefix}${path}`, handler);
      else app.post(`${prefix}${path}`, handler);
    }
  };

  onJudgePaths('get', '/judge/:token', judge(async (c) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    c.header('Content-Security-Policy', judgePagePolicy(nonce));
    return c.html(judgePageHtml(nonce));
  }, true));

  onJudgePaths('get', '/judge/:token/next', judge(async (c, session, database) => {
    const next = await judgeNext(database, session);
    if (next.status !== 'judging') return c.json(next);
    // Image addresses are relative to this link and name only the pair and a side.
    const base = c.req.path.replace(/\/next$/, '');
    return c.json({
      status: next.status,
      judged: next.judged,
      total: next.total,
      pairId: next.pairId,
      left: `${base}/image/${next.pairId}/left`,
      right: `${base}/image/${next.pairId}/right`,
    });
  }));

  onJudgePaths('get', '/judge/:token/image/:pairId/:side', judge(async (c, session, database) => {
    const side = c.req.param('side');
    const pairId = c.req.param('pairId') || '';
    if ((side !== 'left' && side !== 'right') || !isUuid(pairId)) return notFound(c);
    const png = await judgeImage(database, session, pairId, side);
    if (!png) return notFound(c);
    c.header('Content-Type', 'image/png');
    // A neutral name, so a saved image says nothing about where it came from.
    c.header('Content-Disposition', 'inline; filename="design.png"');
    // The address holds the judge's token, so only that judge's browser can reuse it.
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(new Uint8Array(png), 200);
  }));

  onJudgePaths('post', '/judge/:token/judgments', judge(async (c, session, database) => {
    const body = await bodyOf(c);
    const result = await recordJudgment(database, session, { pairId: body.pairId, choice: body.choice, seenBefore: body.seenBefore });
    return c.json({ ok: true, already: result.already }, result.already ? 200 : 201);
  }));
}
