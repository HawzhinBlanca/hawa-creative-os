import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Bug hunt (2026-09-24): the ask ledger is what the art director reads before approving a changed
 * design (AskLedger.tsx, ADR-032 §2.3). There is no DOM in this suite, so React's two hooks are
 * replaced by a tiny recorder for AskLedger.tsx only: the panel's effect is run by hand and the panel
 * is rendered again with the state it set.
 */
const hooks = vi.hoisted(() => ({ states: [] as unknown[], index: 0, effects: [] as Array<() => unknown> }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = hooks.index++;
      if (!(i in hooks.states)) hooks.states[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [hooks.states[i], (v: unknown) => { hooks.states[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.states[i]) : v; }];
    },
    useEffect: (fn: () => unknown) => { hooks.effects.push(fn); },
  };
});

const { AskLedgerPanel } = await import('../src/components/AskLedger.js');

async function renderPanelAfterLoad(taskId: string): Promise<string> {
  hooks.states = []; hooks.index = 0; hooks.effects = [];
  AskLedgerPanel({ taskId });
  for (const effect of hooks.effects) effect();
  await new Promise((r) => setTimeout(r, 0));
  hooks.index = 0; hooks.effects = [];
  return renderToStaticMarkup(AskLedgerPanel({ taskId }));
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the ask ledger when Core cannot answer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a design never changed shows nothing (the intended empty state)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ taskId: 't', rounds: [] }, 200)));
    expect(await renderPanelAfterLoad('11111111-1111-4111-8111-111111111111')).toBe('');
  });

  it('control: a changed design shows its asks through the same harness', async () => {
    const round = { taskId: 't2', title: 'x', round: 1, directive: 'لۆگۆکە بچووک بکەرەوە', asks: [{ ask: 'smaller logo', status: 'not_done' }], sideEffects: [], frustrated: false, taskState: 'human_review' };
    vi.stubGlobal('fetch', vi.fn(async () => json({ taskId: 't2', rounds: [round] }, 200)));
    expect(await renderPanelAfterLoad('11111111-1111-4111-8111-111111111111')).toContain('smaller logo');
  });

  it('a failed read (session expired, 503) is not shown as "this design was never changed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Authentication Required', detail: 'Sign in to Hawa first' }, 401)));
    const expired = await renderPanelAfterLoad('11111111-1111-4111-8111-111111111111');
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Database Unavailable' }, 503)));
    const down = await renderPanelAfterLoad('11111111-1111-4111-8111-111111111111');
    // Both render exactly what a never-changed design renders: nothing. The approver cannot tell that
    // the requester's asks, and which of them were not done, were not read at all.
    expect(expired).not.toBe('');
    expect(down).not.toBe('');
  });
});
