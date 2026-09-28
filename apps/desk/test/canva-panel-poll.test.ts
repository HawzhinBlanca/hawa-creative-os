import { describe, expect, it } from 'vitest';
import { CANVA_PANEL_ACTIVE_POLL_MS, CANVA_PANEL_IDLE_POLL_MS, canvaPanelPollMs, onCanvaPanelWake } from '../src/services/canvaPanelPoll.js';

describe('the Canva panel polls quickly only while Canva or the planner is working', () => {
  it('idle: once a minute (task events refresh it in between)', () => {
    expect(canvaPanelPollMs({})).toBe(CANVA_PANEL_IDLE_POLL_MS);
    expect(canvaPanelPollMs({
      operations: [{ status: 'retrieved' }, { status: 'failed' }, { status: 'stale' }, { status: 'uncertain' }],
      plans: [{ status: 'planned' }, { status: 'uncertain' }],
      results: { a: { status: 'retrieved' } },
    })).toBe(CANVA_PANEL_IDLE_POLL_MS);
  });

  it('an export or a creation still running at Canva: every 5 s', () => {
    expect(canvaPanelPollMs({ operations: [{ status: 'submitted' }] })).toBe(CANVA_PANEL_ACTIVE_POLL_MS);
    expect(canvaPanelPollMs({ operations: [{ status: 'creating' }] })).toBe(CANVA_PANEL_ACTIVE_POLL_MS);
    expect(canvaPanelPollMs({ results: { op: { status: 'submitted' } } })).toBe(CANVA_PANEL_ACTIVE_POLL_MS);
  });

  it('a plan being drafted, or an action in hand: every 5 s', () => {
    expect(canvaPanelPollMs({ plans: [{ status: 'planning' }] })).toBe(CANVA_PANEL_ACTIVE_POLL_MS);
    expect(canvaPanelPollMs({ busy: true })).toBe(CANVA_PANEL_ACTIVE_POLL_MS);
  });

  it('idle is at most a tenth of the old request rate', () => {
    expect(CANVA_PANEL_IDLE_POLL_MS / 5_000).toBeGreaterThanOrEqual(10);
  });
});

// Review finding (2026-09-28): state that changes with no task event (Canva connected in Settings or
// in Canva's own window, an export finished while this tab was hidden, whose ticks are skipped) waited
// for the next minute tick. The panel now reads again as soon as the tab is shown or focused.
describe('the Canva panel reads again when the office comes back to the tab', () => {
  const fakeTab = (hidden: boolean) => {
    const doc = Object.assign(new EventTarget(), { hidden });
    const win = new EventTarget();
    return { doc, win };
  };

  it('refreshes once the tab is shown again or the window regains focus, never while hidden', () => {
    const { doc, win } = fakeTab(true);
    let reads = 0;
    let clock = 10_000;
    const stop = onCanvaPanelWake(() => { reads++; }, doc, win, () => clock);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(0);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(1);
    // A tab switch fires both events: one read, not two.
    win.dispatchEvent(new Event('focus'));
    expect(reads).toBe(1);
    clock += 30_000;
    win.dispatchEvent(new Event('focus'));
    expect(reads).toBe(2);
    clock += 30_000;
    stop();
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(2);
  });

  it('is wired into the panel', async () => {
    const { readFileSync } = await import('node:fs');
    const panel = readFileSync(new URL('../src/components/CanvaTaskPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/onCanvaPanelWake\(/);
  });
});
