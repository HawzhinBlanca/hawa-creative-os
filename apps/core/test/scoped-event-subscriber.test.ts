import { expect, it, vi } from 'vitest';
import { createScopedEventSubscriber, MAX_PENDING_STREAM_EVENTS } from '../src/services/scoped-event-subscriber.js';
import type { StreamEvent } from '../src/services/stream-event-authority.js';
const event = (id: string): StreamEvent => ({ id, event: 'task:transitioned', data: { taskId: id } });
const held = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};

it('preserves event order through slow authorization and writer backpressure without sending denied payloads', async () => {
  const gate = held(), writerGate = held(), writerReached = held(), written: string[] = [], checks: string[] = [], close = vi.fn();
  const subscriber = createScopedEventSubscriber({ authorize: async e => {
    checks.push(e.id); if (e.id === 'first') await gate.promise; return e.id !== 'foreign';
  }, write: async e => { written.push(e.id); if (e.id === 'first') { writerReached.release(); await writerGate.promise; } }, close });
  for (const id of ['first', 'foreign', 'last']) subscriber.receive(event(id));
  await Promise.resolve();
  expect(checks).toEqual(['first']); expect(written).toEqual([]);
  gate.release(); await writerReached.promise;
  expect(checks).toEqual(['first']);
  writerGate.release(); await subscriber.drained();
  expect(checks).toEqual(['first', 'foreign', 'last']); expect(written).toEqual(['first', 'last']);
  expect(close).not.toHaveBeenCalled();
});

it.each(['authorize', 'write'] as const)('closes exactly once on %s failure and never processes later queued payloads', async phase => {
  const authorize = vi.fn(async () => { if (phase === 'authorize') throw new Error('Synthetic authority failure'); return true; });
  const write = vi.fn(async () => { throw new Error('Synthetic stream write failure'); }), close = vi.fn();
  const subscriber = createScopedEventSubscriber({ authorize, write, close });
  subscriber.receive(event('first')); subscriber.receive(event('later')); await subscriber.drained();
  subscriber.receive(event('after-close')); subscriber.stop();
  expect(authorize).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(phase === 'write' ? 1 : 0);
  expect(close).toHaveBeenCalledTimes(1);
});

it('bounds queued work and closes a slow overloaded subscription before any queued disclosure', async () => {
  const gate = held(), close = vi.fn(), write = vi.fn(async () => undefined);
  const authorize = vi.fn(async () => { await gate.promise; return true; });
  const subscriber = createScopedEventSubscriber({ authorize, write, close });
  subscriber.receive(event('held')); await Promise.resolve();
  for (let i = 1; i <= MAX_PENDING_STREAM_EVENTS; i++) subscriber.receive(event(String(i)));
  expect(close).toHaveBeenCalledTimes(1); expect(authorize).toHaveBeenCalledTimes(1);
  gate.release(); await subscriber.drained(); expect(write).not.toHaveBeenCalled();
});

it('stops pending disclosure when the subscription is cancelled during authorization', async () => {
  const gate = held(), close = vi.fn(), write = vi.fn(async () => undefined);
  const subscriber = createScopedEventSubscriber({ authorize: async () => { await gate.promise; return true; }, write, close });
  subscriber.receive(event('first')); await Promise.resolve(); subscriber.stop(); gate.release();
  await subscriber.drained(); expect(write).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});
