import { describe, expect, it } from 'vitest';
import { CANVA_PANEL_ACTIVE_POLL_MS, CANVA_PANEL_IDLE_POLL_MS, canvaPanelPollMs } from '../src/services/canvaPanelPoll.js';

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
