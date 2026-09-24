import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRequestLines, formatLine, runCli } from '../../../scripts/request_logs.js';

/**
 * scripts/request_logs.ts (architecture programme 1.4) reads the daily files Vector writes and prints
 * every line of one request: Core's, the worker's and nginx's, including those of containers a deploy
 * replaced. The fixture below is shaped as Vector 0.58 wrote it in a test on 2026-09-24.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-request-logs-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const taskId = '7d0c7f0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const requestId = 'req-a1b2c3';
const pino = (timestamp: string, container: string, service: string, log: Record<string, unknown>) =>
  JSON.stringify({ timestamp, container_name: container, service, stream: 'stdout', log });
const text = (timestamp: string, container: string, service: string, message: string) =>
  JSON.stringify({ timestamp, container_name: container, service, stream: 'stdout', message });

function write(day: string, service: string, lines: string[]) {
  fs.mkdirSync(path.join(dir, day), { recursive: true });
  fs.writeFileSync(path.join(dir, day, `${service}.ndjson`), lines.join('\n') + '\n');
}

// Day one: the request reaches nginx and Core, whose container a deploy later replaced.
write('2026-09-23', 'nginx', [
  text('2026-09-23T23:59:58.100Z', 'hawa-production-nginx-1', 'nginx', `172.18.0.1 - - [23/Sep/2026:23:59:58 +0000] "POST /v1/tasks HTTP/1.1" 201 512 "-" "desk" rt=0.120 urt=0.119 rid=${requestId}`),
  text('2026-09-23T23:59:58.300Z', 'hawa-production-nginx-1', 'nginx', '172.18.0.1 - - [23/Sep/2026:23:59:58 +0000] "GET /v1/tasks HTTP/1.1" 200 90 "-" "desk" rt=0.010 urt=0.010 rid=req-a1b2c3d'),
]);
write('2026-09-23', 'core', [
  pino('2026-09-23T23:59:58.050Z', 'hawa-production-core-1', 'core', { level: 'info', service: 'core', requestId, tenantId: 't1', msg: 'request', method: 'POST', path: '/v1/tasks', status: 201 }),
  pino('2026-09-23T23:59:58.040Z', 'hawa-production-core-1', 'core', { level: 'warn', service: 'core', requestId, taskId, msg: 'task saved, notice deferred' }),
  pino('2026-09-23T23:59:59.000Z', 'hawa-production-core-1', 'core', { level: 'info', service: 'core', requestId: 'req-other', msg: 'request' }),
]);
// Day two: the worker runs the design under the same request id, and calls back into the new Core.
write('2026-09-24', 'worker-blue', [
  pino('2026-09-24T00:00:05.000Z', 'hawa-production-worker-blue-1', 'worker-blue', { level: 'warn', service: 'worker', requestId, taskId, msg: `[worker] Task ${taskId}: studio run run-1 could not be abandoned` }),
]);
write('2026-09-24', 'core', [
  pino('2026-09-24T00:00:04.000Z', 'hawa-production-core-2', 'core', { level: 'info', service: 'core', requestId, taskId, msg: 'request', method: 'POST', path: `/v1/tasks/${taskId}/canva/studio`, status: 200 }),
  'not json at all',
]);

describe('request_logs', () => {
  it('finds one request\'s lines in files of two days and three services, in time order, and nothing else', async () => {
    const lines = await findRequestLines(dir, requestId);
    expect(lines.map((l) => `${l.timestamp} ${l.service}`)).toEqual([
      '2026-09-23T23:59:58.040Z core',
      '2026-09-23T23:59:58.050Z core',
      '2026-09-23T23:59:58.100Z nginx',
      '2026-09-24T00:00:04.000Z core',
      '2026-09-24T00:00:05.000Z worker-blue',
    ]);
    // A replaced container's lines are there: they come from the files, not from Docker.
    expect(new Set(lines.map((l) => l.container))).toEqual(new Set(['hawa-production-core-1', 'hawa-production-nginx-1', 'hawa-production-core-2', 'hawa-production-worker-blue-1']));
    // req-a1b2c3d is another request, not a match for req-a1b2c3.
    expect(lines.some((l) => l.message?.includes('req-a1b2c3d'))).toBe(false);
  });

  it('given a task id, follows the requests that touched the task, bringing in lines that never name it', async () => {
    const lines = await findRequestLines(dir, taskId);
    expect(lines).toHaveLength(5);
    expect(lines.find((l) => l.service === 'nginx')?.message).toContain('POST /v1/tasks HTTP/1.1');
    expect((await findRequestLines(dir, taskId, { follow: false })).map((l) => l.service)).toEqual(['core', 'core', 'worker-blue']);
  });

  it('prints them for a person, and says where it looked', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([requestId, '--dir', dir], { out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(code).toBe(0);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(formatLine((await findRequestLines(dir, requestId))[0]));
    expect(out[0]).toContain(`warn  [${requestId}] task saved, notice deferred`);
    expect(err.at(-1)).toBe(`5 line(s) for ${requestId} in 4 file(s): core, nginx, worker-blue`);
    expect(await runCli(['req-nowhere', '--dir', dir], { out: () => {}, err: () => {} })).toBe(1);
    expect(await runCli(['--dir', dir], { out: () => {}, err: () => {} })).toBe(64);
  });
});
