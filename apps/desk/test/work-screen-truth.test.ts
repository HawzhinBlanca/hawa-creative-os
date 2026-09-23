import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiError } from '../src/api/client.js';
import { inQueueFilter, searchFold, taskStatusView } from '../src/services/taskStatus.js';

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
  it('shows every open task, not only the newest 50', async () => {
    const list = vi.fn(async (p: { limit?: number; offset?: number }) => {
      const offset = p?.offset ?? 0;
      const items = Array.from({ length: Math.max(0, Math.min(50, 180 - offset)) }, (_, i) => ({
        id: `t${offset + i}`,
        title: `Task ${offset + i}`,
        status: offset + i >= 170 ? 'AWAITING_APPROVAL' : 'COMPLETE',
      }));
      return { items, total: 180, limit: 50, offset };
    });
    let shown: any[] = [];
    const fetchTasks = lift<() => Promise<void>>('fetchTasks', {
      setQueueState: () => {},
      setQueueError: () => {},
      apiClient: { auth: { getSession: async () => ({ authenticated: false }) }, tasks: { list } },
      setSessionUser: () => {},
      setTasks: (v: any[]) => (shown = v),
      setQueueLoads: () => {},
      setSelectedTaskId: () => {},
      ApiError,
    });
    await fetchTasks();
    // The ten oldest tasks, awaiting approval, never reach the screen.
    expect(shown.filter((t) => t.status === 'AWAITING_APPROVAL')).toHaveLength(10);
    expect(shown).toHaveLength(180);
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
