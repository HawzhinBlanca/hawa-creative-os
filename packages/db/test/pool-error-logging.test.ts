import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { attachPoolErrorLogging, describePoolError } from '../src/client.js';

/**
 * ADR-158: when Postgres crashed on 2026-09-30 the pool's idle-client error was logged as the error
 * object, and pg attaches the Client to it (`err.client`): Core's log printed the whole Client,
 * connection parameters included. Pool and connection errors are now one line: code and message.
 */
afterEach(() => vi.restoreAllMocks());

function terminated() {
  const client = { connectionParameters: { user: 'hawa_app', host: 'postgres', password: 'not-for-logs' }, _events: {} };
  return Object.assign(new Error('Connection terminated unexpectedly'), { client, code: 'ECONNRESET' });
}

describe('pool error logging', () => {
  it('logs an idle client\'s error and a checked-out connection\'s error as one line, never the Client', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map((a) => (typeof a === 'string' ? a : `<${typeof a}>`)).join(' ')); });
    const pool = new EventEmitter();
    attachPoolErrorLogging(pool as unknown as pg.Pool);
    pool.emit('error', terminated());
    const client = new EventEmitter();
    pool.emit('connect', client);
    client.emit('error', terminated());
    expect(lines).toEqual([
      '[db:pool] Unexpected error on idle client: ECONNRESET Connection terminated unexpectedly',
      '[db:pool] Connection lost while in use: ECONNRESET Connection terminated unexpectedly',
    ]);
    // Every argument was a string: no object reached the console to be printed in full.
    expect(lines.join('\n')).not.toMatch(/<object>|not-for-logs|connectionParameters/);
  });

  it('describes anything thrown in one line', () => {
    expect(describePoolError(new Error('boom'))).toBe('boom');
    expect(describePoolError('text')).toBe('text');
  });
});
