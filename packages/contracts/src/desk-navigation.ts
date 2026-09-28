/** Navigation only: these identifiers grant no access and record no decision (ADR-065). */
export interface DeskReviewTarget { taskId: string; revisionId?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict allowlist shared by the browser link and OAuth entry point. */
export function parseDeskReviewParams(params: URLSearchParams): DeskReviewTarget | undefined {
  if ([...params.keys()].some(key => key !== 'task' && key !== 'revision') ||
      params.getAll('task').length !== 1 || params.getAll('revision').length > 1) return undefined;
  const taskId = params.get('task')!;
  const revisionId = params.get('revision');
  if (!uuid.test(taskId) || (revisionId !== null && !uuid.test(revisionId))) return undefined;
  return { taskId: taskId.toLowerCase(), ...(revisionId ? { revisionId: revisionId.toLowerCase() } : {}) };
}

export function deskReviewPath(target: DeskReviewTarget): string {
  const params = new URLSearchParams({ task: target.taskId });
  if (target.revisionId) params.set('revision', target.revisionId);
  const checked = parseDeskReviewParams(params);
  if (!checked) throw new Error('Invalid Desk review target');
  return `/#/work?task=${checked.taskId}${checked.revisionId ? `&revision=${checked.revisionId}` : ''}`;
}

export function deskReviewTarget(hash: string): DeskReviewTarget | undefined {
  const legacy = /^#task-(.+)$/.exec(hash);
  if (legacy) return parseDeskReviewParams(new URLSearchParams({ task: legacy[1] }));
  if (!hash.startsWith('#/work?')) return undefined;
  return parseDeskReviewParams(new URLSearchParams(hash.slice('#/work?'.length)));
}

/** Public notification destination. Only a configured HTTPS origin is accepted. */
export function deskReviewUrl(base: string | undefined, target: DeskReviewTarget): string | undefined {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return url.origin + deskReviewPath(target);
  } catch { return undefined; }
}
