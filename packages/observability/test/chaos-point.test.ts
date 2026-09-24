import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chaosPoint } from '../src/chaos-point.js';

/** A control server that records each report and holds the answer while `hold` is true. */
async function control(hold: boolean) {
  const reports: any[] = [];
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      reports.push({ path: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (hold) held.push(res);
      else res.end('{"held":false}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__chaos`;
  return {
    url,
    reports,
    release: () => held.splice(0).forEach((res) => res.end('{"released":true}')),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

describe('chaosPoint: a named place the chaos suite can stop a process at', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does nothing, and calls nobody, when HAWA_CHAOS_CONTROL_URL is not set', async () => {
    vi.stubEnv('HAWA_CHAOS_CONTROL_URL', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) await chaosPoint('worker.sender.after-telegram', { step: 'notice' });
    const perCallUs = ((performance.now() - started) * 1000) / 100_000;
    expect(fetchSpy).not.toHaveBeenCalled();
    // Cheap enough for any hot path: well under a microsecond or two per call.
    expect(perCallUs).toBeLessThan(5);
  });

  it('reports the point, its detail and the service to the control server, and goes on when it is not armed', async () => {
    const ctl = await control(false);
    try {
      vi.stubEnv('HAWA_CHAOS_CONTROL_URL', ctl.url);
      vi.stubEnv('HAWA_CHAOS_SERVICE', 'worker-blue');
      await chaosPoint('worker.outbox.after-claim', { commandType: 'task.created' });
      expect(ctl.reports).toEqual([
        { path: '/__chaos/reach', body: { point: 'worker.outbox.after-claim', detail: { commandType: 'task.created' }, service: 'worker-blue', pid: process.pid } },
      ]);
    } finally {
      await ctl.close();
    }
  });

  it('waits while the control server holds the point, and goes on when it is released', async () => {
    const ctl = await control(true);
    try {
      vi.stubEnv('HAWA_CHAOS_CONTROL_URL', ctl.url);
      let passed = false;
      const point = chaosPoint('worker.step.after-action', { step: 'canva-create-draft' }).then(() => { passed = true; });
      await new Promise((r) => setTimeout(r, 150));
      expect(ctl.reports).toHaveLength(1);
      expect(passed).toBe(false);
      ctl.release();
      await point;
      expect(passed).toBe(true);
    } finally {
      await ctl.close();
    }
  });

  it('never stops the caller when the control server cannot be reached', async () => {
    vi.stubEnv('HAWA_CHAOS_CONTROL_URL', 'http://127.0.0.1:9/__chaos');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(chaosPoint('worker.outbox.before-record')).resolves.toBeUndefined();
    await expect(chaosPoint('worker.outbox.before-record')).resolves.toBeUndefined();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
