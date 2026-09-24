import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiError } from '../src/api/client.js';
import { approveButtonState, inQueueFilter, queueFilterStatuses, searchFold, taskStatusView } from '../src/services/taskStatus.js';
import { TASK_API_STATUSES } from '@hawa/contracts/task-status';

/**
 * Bug hunt (2026-09-24): what the Work screen tells an office member about a real request.
 *
 * The screen's logic lives inside the WorkScreen component. There is no DOM in this suite, so the
 * shipped functions are lifted out of WorkScreen.tsx with the TypeScript parser, compiled, and run
 * with stand-ins for the React setters they close over. Nothing here is a copy of the logic.
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/screens/WorkScreen.tsx'), 'utf8');
const FILE = ts.createSourceFile('WorkScreen.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function initializer(name: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  if (!found) throw new Error(`WorkScreen.tsx has no const ${name}`);
  return found;
}

/** The shipped function `name` (or, for `useMemo(fn, deps)`, its fn), bound to the given closure. */
function lift<T>(name: string, closure: Record<string, unknown>): T {
  let node = initializer(name);
  if (ts.isCallExpression(node)) node = node.arguments[0];
  const js = ts.transpileModule(`const __lifted = ${node.getText(FILE)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText;
  const keys = Object.keys(closure);
  return new Function(...keys, `${js}\nreturn __lifted;`)(...keys.map((k) => closure[k])) as T;
}

type Prompt = { pill: string; message: string; primaryButton: string };
// The labels and filter groups are one table the Work screen imports (services/taskStatus.ts); the
// lifted functions get it from their closure like the setters.
const nextAction = lift<(task: any) => Prompt>('getNextActionPrompt', { taskStatusView });
const approval = { decisionId: 'd-old', role: 'art_director', decidedAt: '2026-09-20T10:00:00.000Z' };

describe('the status an office member sees for each state Core reports (WorkScreen getNextActionPrompt)', () => {
  // Core emits these itself: toApiTaskStatus (packages/db task.repository.ts) and the canva-status
  // handler's broadcast (apps/core/src/app.ts: deskStatus = 'OPERATOR_REQUIRED' | 'PAUSED' | 'AWAITING_APPROVAL').
  it('a task waiting for the requester to answer a question (PAUSED) is not shown as a new request to design', () => {
    const p = nextAction({ id: 't', title: 't', status: 'PAUSED' });
    expect(p.pill).not.toBe('RECEIVED');
    expect(p.message).not.toMatch(/Use the Canva controls below to design/);
  });

  it('a task that needs a designer (OPERATOR_REQUIRED: the automatic draft failed) is not shown as RECEIVED', () => {
    expect(nextAction({ id: 't', title: 't', status: 'OPERATOR_REQUIRED' }).pill).not.toBe('RECEIVED');
  });

  it('a design that is being made right now (COMPOSING) is not shown as RECEIVED', () => {
    expect(nextAction({ id: 't', title: 't', status: 'COMPOSING' }).pill).not.toBe('RECEIVED');
  });

  it('a cancelled or rejected task is not offered for design', () => {
    expect(nextAction({ id: 't', title: 't', status: 'CANCELLED' }).pill).not.toBe('RECEIVED');
    expect(nextAction({ id: 't', title: 't', status: 'REJECTED' }).pill).not.toBe('RECEIVED');
  });

  it('a new revision awaiting approval is NEEDS APPROVAL even though an earlier revision was approved', () => {
    // GET /tasks and GET /tasks/:id return the newest approved approval of the task, whatever revision it was for.
    expect(nextAction({ id: 't', title: 't', status: 'AWAITING_APPROVAL', latestApproval: approval }).pill).toBe('NEEDS APPROVAL');
  });

  it('a task sent back for changes is not labelled APPROVED because of its old approval', () => {
    expect(nextAction({ id: 't', title: 't', status: 'REVISION_REQUESTED', latestApproval: approval }).pill).not.toBe('APPROVED');
  });
});

describe('the Approve button of the task on screen (WorkScreen approveState)', () => {
  // A draft with a revision whose QA passed: only its status decides.
  const state = (status: unknown) =>
    lift<string>('approveState', {
      selectedTask: { id: 't', title: 't', status, latestRevisionId: 'r1', qaReport: { passed: true } },
      actionLoading: false,
      approveButtonState,
    });

  it('is not shown for a status the Desk does not know (it could be approved until 2026-09-24)', () => {
    for (const unknown of ['ON_HOLD', 'IN_PROGRESS', 'CHANGES_REQUESTED', undefined]) expect(state(unknown), String(unknown)).toBe('hidden');
  });

  it('is enabled only for a draft awaiting approval; every other status Core reports shows it disabled', () => {
    expect(state('AWAITING_APPROVAL')).toBe('enabled');
    for (const status of TASK_API_STATUSES.filter((s) => s !== 'AWAITING_APPROVAL')) expect(state(status), status).toBe('disabled');
  });

  it('no status but RECEIVED reads as RECEIVED', () => {
    for (const status of TASK_API_STATUSES.filter((s) => s !== 'RECEIVED')) expect(nextAction({ id: 't', title: 't', status }).pill, status).not.toBe('RECEIVED');
    expect(nextAction({ id: 't', title: 't', status: 'ON_HOLD' }).pill).toBe('UNKNOWN: ON HOLD');
  });
});

describe('the queue filters (WorkScreen filteredTasks)', () => {
  const tasks = [
    { id: 'a', title: 'Needs a designer', status: 'OPERATOR_REQUIRED' },
    { id: 'b', title: 'Being made', status: 'COMPOSING' },
    { id: 'c', title: 'Ready to approve', status: 'AWAITING_APPROVAL' },
  ];
  const filtered = (filter: string) => lift<() => Array<{ id: string }>>('filteredTasks', { tasks, filter, searchQuery: '', inQueueFilter, searchFold })().map((t) => t.id);

  it('"Needs Action" includes a task whose automatic draft failed and needs a designer', () => {
    expect(filtered('needs_action')).toContain('a');
  });

  it('"In Design" includes a design being made (Core never reports IN_PROGRESS from the database)', () => {
    expect(filtered('in_progress')).toContain('b');
  });
});

describe('Request Revision (WorkScreen handleSendRevisionRequest)', () => {
  it('does not report a revision request as logged when nothing was sent to Core', async () => {
    const toasts: Array<{ text: string; type: string }> = [];
    const recordDecision = vi.fn(async () => ({}));
    const send = lift<() => Promise<void>>('handleSendRevisionRequest', {
      // A task with no design revision yet: a failed draft, a paused question, a Desk-made request.
      selectedTask: { id: 't1', title: 'KAAE evening', status: 'OPERATOR_REQUIRED' },
      revisionNotes: 'Make the Kurdish headline bigger and move the logo left',
      setActionLoading: () => {},
      apiClient: { tasks: { recordDecision, get: vi.fn(async () => ({ id: 't1', status: 'OPERATOR_REQUIRED' })) } },
      setTasks: () => {},
      setIsRevisionModalOpen: () => {},
      setRevisionNotes: () => {},
      showToast: (text: string, type: string) => toasts.push({ text, type }),
    });
    await send();
    expect(recordDecision).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.text)).not.toContainEqual(expect.stringContaining('Revision request logged'));
  });
});

describe('the task queue (WorkScreen fetchTasks)', () => {
  // 180 tasks, newest first; the ten oldest await approval. Core filters by `statuses` and pages by
  // cursor as GET /tasks does.
  const all = Array.from({ length: 180 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: i >= 170 ? 'AWAITING_APPROVAL' : 'COMPLETE' }));
  const core = () =>
    vi.fn(async (p: { limit?: number; cursor?: string | null; statuses?: readonly string[]; q?: string }) => {
      const matching = p.statuses ? all.filter((t) => p.statuses!.includes(t.status)) : all;
      const start = p.cursor ? Number(p.cursor) : 0;
      const items = matching.slice(start, start + (p.limit ?? 50));
      const next = start + items.length;
      return { items, total: matching.length, limit: p.limit, nextCursor: next < matching.length ? String(next) : null };
    });
  const screen = (list: ReturnType<typeof core>, view: { cursor: string | null; filter: string; search: string }) => {
    const shown = { tasks: [] as any[], total: -1, next: undefined as string | null | undefined };
    const getSession = vi.fn(async () => ({ authenticated: false }));
    const fetchTasks = lift<(quiet?: boolean) => Promise<void>>('fetchTasks', {
      queueViewRef: { current: view },
      queueReadSeq: { current: 0 },
      QUEUE_PAGE_SIZE: 50,
      queueFilterStatuses,
      setQueueState: () => {},
      setQueueError: () => {},
      apiClient: { auth: { getSession }, tasks: { list } },
      setSessionUser: () => {},
      setQueueTotal: (n: number) => (shown.total = n),
      setNextCursor: (c: string | null) => (shown.next = c),
      selectedTaskIdRef: { current: '' },
      tasksRef: { current: [] },
      initialTaskIdRef: { current: undefined },
      setTasks: (v: any) => (shown.tasks = typeof v === 'function' ? v(shown.tasks) : v),
      keepLoadedDetail: (_prev: any[], items: any[]) => items,
      queueEntryChanged: () => false,
      setQueueLoads: () => {},
      setSelectedTaskId: () => {},
      ApiError,
    });
    return { fetchTasks, shown, getSession };
  };

  it('reads one page, not every page, and shows the total Core reports', async () => {
    const list = core();
    const { fetchTasks, shown } = screen(list, { cursor: null, filter: 'all', search: '' });
    await fetchTasks();
    expect(list).toHaveBeenCalledTimes(1);
    expect(shown.tasks).toHaveLength(50);
    expect(shown.total).toBe(180);
    expect(shown.next).toBe('50');
  });

  it('finds the older tasks awaiting approval through the filter, which Core applies', async () => {
    // Filtering only the page on screen would show none of the ten oldest tasks awaiting approval.
    const list = core();
    const { fetchTasks, shown } = screen(list, { cursor: null, filter: 'review', search: '' });
    await fetchTasks();
    expect(list.mock.calls[0][0].statuses).toEqual(['AWAITING_APPROVAL']);
    expect(shown.tasks.filter((t) => t.status === 'AWAITING_APPROVAL')).toHaveLength(10);
    expect(shown.total).toBe(10);
  });

  it('a background refresh reads the page on screen again, with no session read', async () => {
    const list = core();
    const { fetchTasks, getSession } = screen(list, { cursor: '100', filter: 'all', search: 'evening' });
    await fetchTasks(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toMatchObject({ cursor: '100', q: 'evening', limit: 50 });
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe('Kurdish titles and headlines in the queue (WorkScreen JSX)', () => {
  // Measured in a local Desk (Chromium, English locale) on a Kurdish request: the card snippet is one
  // line with text-overflow: ellipsis in an LTR box, so the clipped end is the visual right, which is
  // the START of a right-to-left headline. Its first word was the one cut off.
  const elementsWithClass = (cls: string) => {
    const found: ts.JsxOpeningLikeElement[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(FILE) === 'className' && p.initializer?.getText(FILE) === `"${cls}"`)) {
        found.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(FILE);
    return found;
  };
  const hasDir = (el: ts.JsxOpeningLikeElement) => el.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(FILE) === 'dir');

  it.each(['card-title', 'card-snippet', 'detail-title'])('the %s element sets its direction from its own text (dir="auto")', (cls) => {
    const elements = elementsWithClass(cls);
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.every(hasDir)).toBe(true);
  });
});

describe('Sign Out (api/client.ts auth.logout)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ends the session on the server, not only in this tab', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"ok":true,"token":"hawa_sess_hunt"}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    await apiClient.auth.login({ key: 'k' }).catch(() => undefined);
    fetchSpy.mockClear();
    apiClient.auth.logout();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledWith('/v1/auth/session', expect.objectContaining({ method: 'DELETE' }));
  });
});
