import { evaluateVisionRubric, type RubricCanvasNode } from '@hawa/qa';
import type { RouteContext } from './types.js';
import type { Context } from 'hono';

/**
 * The visual QA rubric scorer and its reports. Moved out of app.ts by group G1 (leaves) of the split
 * (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerRubricRoutes(ctx: RouteContext): void {
  const { registerRoute, problem, resolveTaskWithFallback, resolveClientDna, broadcastEvent: broadcast } = ctx;

  // Multilingual Visual QA Vision Rubric Scorer (FR-039, FR-041, Invariant #9, Gate E)
  registerRoute('post', '/tasks/:taskId/revisions/:revisionId/evaluate-rubric', async (c: any) => {
    const taskId = c.req.param('taskId');
    const revisionId = c.req.param('revisionId');
    const task = await resolveTaskWithFallback(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    // The client's brand colours are part of the score. A task that names no client used to be
    // scored as the fixture office client-office-1 (SPLIT_PLAN.md section 6).
    const clientId: string | undefined = task.clientId || undefined;
    if (!clientId) return problem(c, 422, 'CLIENT_REQUIRED', 'The task names no client, so there are no brand colours to score against. Assign the client first.');
    const client = await resolveClientDna(clientId);

    const body = await c.req.json().catch(() => ({}));

    const format = body.format || 'story';
    const dimensions = body.dimensions || (format === 'story' ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 });

    const primaryColor = client?.colors?.find((c) => c.role === 'primary')?.hex || '#111827';
    const secondaryColor = client?.colors?.find((c) => c.role === 'secondary')?.hex || '#374151';
    const accentColor = client?.colors?.find((c) => c.role === 'accent')?.hex || '#D97706';

    // The rubric scores the revision the caller sends. A sample canvas scored in its place would
    // report a grade for a design that does not exist.
    const nodes: RubricCanvasNode[] = body.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return problem(c, 422, 'NODES_REQUIRED', 'Send the canvas nodes of the revision to score. No sample canvas is scored in its place.');
    }

    // Approved copy is what the client sent, never the task title and never sample prices or phones.
    const sentCopy = Object.fromEntries(
      (['headlineEn', 'headlineCkb', 'copyEn', 'copyCkb'] as const)
        .map((field) => [field, (task as any)[field]])
        .filter(([, value]) => typeof value === 'string' && value.trim())
    );
    const approvedCopy = body.approvedCopy || (Object.keys(sentCopy).length > 0 ? sentCopy : undefined);

    const brandColors = body.brandColors || [primaryColor, secondaryColor, accentColor];

    const report = evaluateVisionRubric({
      taskId,
      revisionId,
      clientId,
      format,
      nodes,
      brandColors,
      approvedCopy,
      dimensions,
    });

    broadcast('qa:rubric_evaluated', { taskId, revisionId, report });

    return c.json(report, 200);
  });

  // The reports were kept in this process's memory: lost on a restart, different in each Core, and
  // never read by the Desk. Nothing stores them now (SPLIT_PLAN.md section 7, G1), so this says so
  // rather than answering with an empty list that reads as "never scored".
  registerRoute('get', '/tasks/:taskId/rubric-reports', (c: Context) =>
    problem(c, 410, 'Gone', 'Rubric reports are not stored. POST .../evaluate-rubric returns each report to its caller.'));
}
