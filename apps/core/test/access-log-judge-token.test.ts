import { afterEach, describe, expect, it } from 'vitest';
import { captureLogs, redactLogString } from '@hawa/observability';
import { createApp } from '../src/app.js';

/**
 * A comparison judge's link token is the judge's only credential, and it is in the path
 * (comparison.routes.ts, /judge/:token under every prefix). nginx writes it as *** in its access log;
 * Core's own lines, which Vector keeps for 30 days, must not write it either (1.4 review).
 */

let capture: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
});

describe('Core access log never writes a judge link token', () => {
  it('masks /judge/:token on every prefix', async () => {
    capture = captureLogs();
    const app = createApp();
    const token = ['jdg', 'Secret', 'Token', '0123456789abcdef'].join('');
    for (const p of [`/api/judge/${token}/next`, `/v1/judge/${token}`, `/judge/${token}/image/p1/left`, `/api/v1/judge/${token}/judgments`]) {
      await app.request(p, p.endsWith('judgments') ? { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } } : undefined);
    }
    const access = capture.lines.filter((l) => l.msg === 'request');
    expect(access.length).toBeGreaterThanOrEqual(4);
    for (const line of capture.lines) expect(JSON.stringify(line)).not.toContain(token);
    expect(access.map((l) => l.path)).toContain('/api/judge/***/next');
  });

  it('masks a judge link in any string written to a log, as nginx does', () => {
    const token = ['jdg', 'Other', '9876'].join('');
    expect(redactLogString(`fetch https://hawa.example/api/judge/${token}/image/p1/left?x=1 failed`)).toBe(
      'fetch https://hawa.example/api/judge/***/image/p1/left?x=1 failed'
    );
    expect(redactLogString(`/judge/${token}`)).toBe('/judge/***');
  });
});
