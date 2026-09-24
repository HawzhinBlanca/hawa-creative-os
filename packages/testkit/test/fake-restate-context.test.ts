import { describe, expect, it } from 'vitest';
import { FakeCrash, FakeJournalMismatch, FakeObjectContext } from '../src/fake-restate-context.js';

/**
 * The fake Restate context the lifecycle handler tests run on (PHASE2_DESIGN.md section 3,
 * "Handler"): it must replay the way Restate does, or a handler that is wrong on a real crash would
 * pass its tests.
 */
const target = { name: 'Other' };
const sendOpts = (opts: Record<string, unknown>) => ({ getOpts: () => opts });

async function handler(ctx: FakeObjectContext, effects: string[]): Promise<number> {
  const count = ((await ctx.get<number>('count')) ?? 0) + 1;
  const at = await ctx.date.now();
  const answer = await ctx.run('call core', async () => { effects.push('core'); return { ok: true, at }; });
  ctx.set('count', count);
  ctx.objectSendClient(target, 'k1').ping({ count, answer }, sendOpts({ idempotencyKey: `ping:${count}`, delay: 5000 }));
  return count;
}

describe('FakeObjectContext', () => {
  it('crashed after any entry and replayed: each step runs once, each send is journaled once, the result is the same', async () => {
    const baseline = new FakeObjectContext({ key: 'a', clock: () => 1000 });
    const effects0: string[] = [];
    expect(await handler(baseline, effects0)).toBe(1);
    baseline.commit();
    expect(baseline.journal.map((e) => e.kind)).toEqual(['get', 'now', 'run', 'set', 'send']);

    for (let n = 1; n <= baseline.journal.length; n++) {
      let clockReads = 0;
      const ctx = new FakeObjectContext({ key: 'a', clock: () => { clockReads++; return 1000; } }).crashAfter(n);
      const effects: string[] = [];
      await expect(handler(ctx, effects)).rejects.toBeInstanceOf(FakeCrash);
      ctx.replay();
      expect(await handler(ctx, effects)).toBe(1);
      ctx.commit();
      expect(effects).toEqual(['core']);
      expect(ctx.sends).toEqual(baseline.sends);
      expect(ctx.sends[0]).toMatchObject({ service: 'Other', key: 'k1', handler: 'ping', delayMs: 5000, idempotencyKey: 'ping:1' });
      expect(ctx.state.get('count')).toBe(1);
      // A journaled clock read is replayed, never read again.
      expect(clockReads).toBe(1);
    }
  });

  it('a crash inside a step, after its action, runs the action again on replay', async () => {
    const ctx = new FakeObjectContext({ key: 'b' }).crashInStep('call core');
    const effects: string[] = [];
    await expect(handler(ctx, effects)).rejects.toBeInstanceOf(FakeCrash);
    ctx.replay();
    await handler(ctx, effects);
    expect(effects).toEqual(['core', 'core']);
    expect(ctx.stepRuns.get('call core')).toBe(2);
  });

  it('state written by an unfinished invocation is not the object\'s until it completes', async () => {
    const state = new Map<string, unknown>();
    const ctx = new FakeObjectContext({ key: 'c', state }).crashAfter(5);
    await expect(handler(ctx, [])).rejects.toBeInstanceOf(FakeCrash);
    expect(state.has('count')).toBe(false);
  });

  it('a bounded step gives up with a journaled terminal error; an unbounded one fails the attempt', async () => {
    const ctx = new FakeObjectContext({ key: 'd', terminalError: (m) => Object.assign(new Error(m), { name: 'TerminalError' }) });
    let tries = 0;
    const failing = async () => { tries++; throw new Error('down'); };
    await expect(ctx.run('bounded', failing, { maxRetryDuration: 1000 })).rejects.toMatchObject({ name: 'TerminalError', message: 'down' });
    expect(tries).toBe(3);
    await expect(ctx.run('unbounded', failing)).rejects.toThrow('down');
    expect(ctx.journal.map((e) => e.kind === 'run' ? `${e.name}:${e.ok}` : e.kind)).toEqual(['bounded:false']);
    ctx.replay();
    await expect(ctx.run('bounded', failing, { maxRetryDuration: 1000 })).rejects.toMatchObject({ name: 'TerminalError' });
    expect(tries).toBe(4);
  });

  it('a replay that asks for something else than the journal holds is a journal mismatch', async () => {
    const ctx = new FakeObjectContext({ key: 'e' });
    ctx.objectSendClient(target, 'k1').ping({ n: 1 });
    ctx.replay();
    expect(() => ctx.objectSendClient(target, 'k1').ping({ n: 2 })).toThrow(FakeJournalMismatch);
    ctx.replay();
    await expect(ctx.get('x')).rejects.toBeInstanceOf(FakeJournalMismatch);
  });
});
