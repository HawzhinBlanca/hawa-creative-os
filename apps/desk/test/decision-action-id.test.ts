import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Desk decision action identity', () => {
  it('reuses the same UUID after a browser module reload and clears it only after success', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    const input = JSON.stringify(['task-1', 'revision-1', 'revision_requested', 'Private revision note']);
    const firstModule = await import('../src/services/decisionActionId.js');
    const first = await firstModule.reserveDecisionAction(input);
    expect(first.storageKey).toMatch(/^hawa:decision:[0-9a-f]{64}$/);
    expect([...values.keys()].join(' ')).not.toContain('Private revision note');

    vi.resetModules(); // a fresh screen/module has no in-memory reservation
    const freshModule = await import('../src/services/decisionActionId.js');
    const retry = await freshModule.reserveDecisionAction(input);
    expect(retry.actionId).toBe(first.actionId);
    const changed = await freshModule.reserveDecisionAction(input.replace('Private revision note', 'Different note'));
    expect(changed.actionId).not.toBe(first.actionId);

    freshModule.completeDecisionAction(input, retry);
    expect(values.has(first.storageKey!)).toBe(false);
    vi.resetModules();
    const afterSuccess = await import('../src/services/decisionActionId.js');
    expect((await afterSuccess.reserveDecisionAction(input)).actionId).not.toBe(first.actionId);
  });
});
