import { describe, it, expect, afterAll } from 'vitest';
import { createDb } from '@hawa/db';
import { probeDatabase, createApp } from '../src/app.js';

/**
 * /health is what the watchdog reads. Its database probe started at 'connected' and only turned to
 * 'disconnected' for ECONNREFUSED or a message containing "connect", so every other failure kept
 * health green.
 */
describe('probeDatabase: connected is a result, never a default', () => {
  const real = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(async () => { await real.destroy(); });

  it('reports a real PostgreSQL as connected', async () => {
    expect(await probeDatabase(real)).toBe('connected');
  });

  it('reports no handle as uninitialized, not connected', async () => {
    expect(await probeDatabase(undefined)).toBe('uninitialized');
    expect(await probeDatabase(null)).toBe('uninitialized');
  });

  it('reports a wrong password as disconnected', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.password = ['not', 'the', 'password'].join('-');
    const bad = createDb(url.toString());
    try {
      expect(await probeDatabase(bad)).toBe('disconnected');
    } finally {
      await bad.destroy();
    }
  });

  it('reports a server that refuses, or a host that does not exist, as disconnected', async () => {
    const refused = createDb('postgres://hawa:x@127.0.0.1:1/hawa_test');
    try {
      expect(await probeDatabase(refused)).toBe('disconnected');
    } finally {
      await refused.destroy();
    }
  });

  it('reports a database that does not answer in time as disconnected', async () => {
    // An executor whose query never settles: a hung server, or a pool with no free connection.
    const hung = { getExecutor: () => ({ executeQuery: () => new Promise(() => {}), transformQuery: (n: unknown) => n, compileQuery: () => ({ sql: 'SELECT 1', parameters: [] }) }) };
    const started = Date.now();
    expect(await probeDatabase(hung, 150)).toBe('disconnected');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reports errors the old probe ignored (no ECONNREFUSED, no "connect" in the message) as disconnected', async () => {
    const failing = { getExecutor: () => ({ executeQuery: () => Promise.reject(Object.assign(new Error('permission denied for schema hawa'), { code: '42501' })), transformQuery: (n: unknown) => n, compileQuery: () => ({ sql: 'SELECT 1', parameters: [] }) }) };
    expect(await probeDatabase(failing)).toBe('disconnected');
  });

  it('/health answers 503 when the database is down', async () => {
    const down = createDb('postgres://hawa:x@127.0.0.1:1/hawa_test');
    try {
      const res = await createApp({ db: down }).request('/health');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.postgres).toBe('disconnected');
    } finally {
      await down.destroy();
    }
  }, 30_000);
});
