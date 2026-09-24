import { describe, expect, it } from 'vitest';
import { WORKER_SERVICES } from '../../../scripts/restate-bluegreen.js';
import { WORKER_SERVICE_NAMES } from '../src/services.js';
import { HANDLERS_EVER, SHIM_KEEP_DAYS, handlersOf, missingHandlers, mustBeBound, shimHandler, type HandlerRecord } from '../src/lifecycle/shims.js';
import { workerServices } from '../src/worker-services.js';

/**
 * A handler is never removed while anything may still target it (PHASE2_DESIGN.md section 4 rule 2),
 * and a service is never removed from the build (rule 3). HANDLERS_EVER is the checked-in record of
 * every handler any build bound; this build must bind each one that is live or retired less than
 * SHIM_KEEP_DAYS ago.
 */
const DAY = 86_400_000;

describe('the handlers this build binds', () => {
  const services = workerServices();

  it('are every service ever hosted: the worker\'s list and the blue/green deploy\'s', () => {
    const names = services.map((s) => s.name).sort();
    expect(names).toEqual([...WORKER_SERVICE_NAMES].sort());
    expect(names).toEqual([...WORKER_SERVICES].sort());
    expect(names).toEqual(expect.arrayContaining(['RequestLifecycle', 'DesignRun', 'TaskWorkflow']));
  });

  it('include every handler in HANDLERS_EVER that must still be bound, today and in 21 days', () => {
    expect(missingHandlers(services)).toEqual([]);
    expect(missingHandlers(services, HANDLERS_EVER, Date.now() + SHIM_KEEP_DAYS * DAY)).toEqual([]);
  });

  it('are all in the record: a handler bound without an entry would be removable unnoticed', () => {
    const recorded = new Set(HANDLERS_EVER.map((h) => `${h.service}/${h.handler}`));
    const bound = services.flatMap((s) => handlersOf(s).map((h) => `${s.name}/${h}`));
    expect(bound.filter((b) => !recorded.has(b))).toEqual([]);
    expect(new Set(HANDLERS_EVER.map((h) => h.service))).toEqual(new Set(WORKER_SERVICE_NAMES));
  });

  it('the record never lists a handler twice', () => {
    const keys = HANDLERS_EVER.map((h) => `${h.service}/${h.handler}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('retired handlers', () => {
  const retired: HandlerRecord = { service: 'RequestLifecycle', handler: 'nudge', since: '2.3', retiredAt: '2026-10-01' };
  const at = (iso: string) => Date.parse(iso);

  it('must stay bound (as shims) for 21 days after retiredAt, and may go after', () => {
    expect(mustBeBound(retired, at('2026-10-21T23:59:59Z'))).toBe(true);
    expect(mustBeBound(retired, at('2026-10-22T00:00:00Z'))).toBe(false);
    expect(mustBeBound({ ...retired, retiredAt: 'soon' }, at('2030-01-01'))).toBe(true);
  });

  it('a build without a shim for a handler retired a week ago does not start; one with it does', () => {
    const record = [...HANDLERS_EVER, retired];
    const without = workerServices();
    expect(missingHandlers(without, record, at('2026-10-08'))).toEqual(['RequestLifecycle/nudge']);
    const withShim = [...without, { name: 'RequestLifecycle', object: { nudge: shimHandler('RequestLifecycle', 'nudge', null) } }];
    expect(missingHandlers(withShim, record, at('2026-10-08'))).toEqual([]);
    expect(missingHandlers(without, record, at('2026-11-01'))).toEqual([]);
  });

  it('a shim answers its neutral value and does nothing else', async () => {
    const shim = shimHandler('DesignRun', 'run', { status: 'RETIRED' });
    expect(await shim({}, { v: 1, taskId: 't' })).toEqual({ status: 'RETIRED' });
  });
});
