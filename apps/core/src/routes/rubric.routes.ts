import { evaluateVisionRubric, type RubricCanvasNode } from '@hawa/qa';
import type { RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID } from '../core-context.js';

/**
 * The visual QA rubric scorer and its reports. Moved out of app.ts by group G1 (leaves) of the split
 * (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerRubricRoutes(ctx: RouteContext): void {
  const { registerRoute, problem, resolveTaskWithFallback, resolveClientDna, rubricReports, broadcastEvent: broadcast } = ctx;
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Multilingual Visual QA Vision Rubric Scorer (FR-039, FR-041, Invariant #9, Gate E)
  registerRoute('post', '/tasks/:taskId/revisions/:revisionId/evaluate-rubric', async (c: any) => {
    const taskId = c.req.param('taskId');
    const revisionId = c.req.param('revisionId');
    const task = await resolveTaskWithFallback(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    const clientId = task.clientId || defaultClientId;
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

    const existingReports = rubricReports.get(taskId) || [];
    existingReports.push(report);
    rubricReports.set(taskId, existingReports);

    broadcast('qa:rubric_evaluated', { taskId, revisionId, report });

    return c.json(report, 200);
  });

  registerRoute('get', '/tasks/:taskId/rubric-reports', async (c: any) => {
    const taskId = c.req.param('taskId');
    const reports = rubricReports.get(taskId) || [];
    return c.json(reports, 200);
  });
}
