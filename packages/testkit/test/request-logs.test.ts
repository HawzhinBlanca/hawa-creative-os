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

/**
 * The worker's Restate SDK lines name a task only inside the invocation's key: TaskWorkflow runs as
 * task-wf-<taskId> (task-wf-<taskId>-redrive-<n> when re-driven), DesignRun as dr-<taskId>[-a<n>],
 * Delivery as dl-<taskId>-<approvalId>[:archive:<n>]. The lines below are copied from
 * hawa-chaos-worker-blue-1 on 2026-09-28 (`docker logs --timestamps`, written in Vector's layout as
 * scripts/load/export-chaos-logs.ts writes it), with the fixture's ids put in.
 */
describe('request_logs on the worker\'s Restate lines', () => {
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-request-logs-restate-'));
  afterAll(() => fs.rmSync(wdir, { recursive: true, force: true }));
  const approvalId = '3b9e1f24-5c6d-4e7f-8a9b-0c1d2e3f4a5b';
  const otherTaskId = 'e837a4e4-7808-41e3-a435-152d19a05697';
  const restate = (timestamp: string, target: string, inv: string, rest: string) =>
    JSON.stringify({ timestamp, service: 'worker-green', container_name: 'hawa-chaos-worker-green-1', message: `[restate][${timestamp.slice(0, 23)}Z][${target}][${inv}] ${rest}` });
  const workerPino = (timestamp: string, log: Record<string, unknown>) =>
    JSON.stringify({ timestamp, service: 'worker-green', container_name: 'hawa-chaos-worker-green-1', log: { level: 'info', time: `${timestamp.slice(0, 23)}Z`, service: 'worker', ...log } });
  const wf = 'inv_1jQLgVMhRi8800zKle1fGXCpKb7JarQsHN';
  const redrive = 'inv_1fx5ttOCXssO12LEWcLCOvYXCWSds6WYdK';
  const design = 'inv_1eqmjOZqZHu25DQrJ1YgRVlkjNeRB6lU32';
  const delivery = 'inv_17q3zCwJNhWz4fc7o8qtYbexBrtgqrIo4k';
  const archive = 'inv_1aQ2wE3rT4yU5iO6pA7sD8fG9hJ0kL1zXc';

  fs.mkdirSync(path.join(wdir, '2026-09-24'), { recursive: true });
  fs.writeFileSync(path.join(wdir, '2026-09-24', 'core.ndjson'), [
    JSON.stringify({ timestamp: '2026-09-24T21:20:00.558912345Z', service: 'core', container_name: 'hawa-chaos-core-1', log: { level: 'info', service: 'core', requestId: 'tg-90284190571', taskId, msg: 'task created' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(wdir, '2026-09-24', 'worker-green.ndjson'), [
    restate('2026-09-24T21:20:01.596138380Z', `TaskWorkflow/task-wf-${taskId}/run`, wf, 'INFO: Starting invocation.'),
    restate('2026-09-24T21:20:01.778392054Z', `TaskWorkflow/task-wf-${taskId}/run`, wf, "WARN: Error when processing ctx.run 'canva-verify-task-scope'."),
    restate('2026-09-24T21:20:02.030717382Z', `TaskWorkflow/task-wf-${taskId}/run`, wf, 'INFO: Invocation completed successfully.'),
    restate('2026-09-24T21:20:03.100000000Z', `TaskWorkflow/task-wf-${taskId}-redrive-1/run`, redrive, 'INFO: Starting invocation.'),
    restate('2026-09-24T21:20:04.200000000Z', `DesignRun/dr-${taskId}-a1/run`, design, 'INFO: Invocation completed successfully.'),
    restate('2026-09-24T21:20:05.300000000Z', `Delivery/dl-${taskId}-${approvalId}/run`, delivery, 'INFO: Starting invocation.'),
    // Logged in the Delivery invocation before its input named the task: the request id is the invocation's.
    workerPino('2026-09-24T21:20:05.310000000Z', { requestId: `restate-${delivery}`, msg: '[Delivery] files prepared' }),
    restate('2026-09-24T21:20:06.400000000Z', `Delivery/dl-${taskId}-${approvalId}:archive:2/run`, archive, 'INFO: Starting invocation.'),
    // Longer ids that merely contain the task id, and another task: none of these is the task's.
    restate('2026-09-24T21:20:07.000000000Z', `TaskWorkflow/task-wf-${taskId}0/run`, 'inv_1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'INFO: Starting invocation.'),
    restate('2026-09-24T21:20:07.100000000Z', `Delivery/dl-${taskId}-${approvalId}0/run`, 'inv_1yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', 'INFO: Starting invocation.'),
    restate('2026-09-24T21:20:07.200000000Z', `Delivery/dl-x${taskId}-${approvalId}/run`, 'inv_1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'INFO: Starting invocation.'),
    restate('2026-09-24T21:20:07.300000000Z', `TaskWorkflow/task-wf-${otherTaskId}/run`, 'inv_1wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww', 'INFO: Starting invocation.'),
    workerPino('2026-09-24T21:20:07.400000000Z', { requestId: 'restate-inv_1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', msg: '[TaskWorkflow] not this task' }),
  ].join('\n') + '\n');

  it('given a task id, finds the Restate lines of every invocation keyed by it, and the lines logged under those invocations', async () => {
    const lines = await findRequestLines(wdir, taskId);
    expect(lines.map((l) => `${l.service} ${l.message ?? l.log?.msg}`)).toEqual([
      'core task created',
      `worker-green [restate][2026-09-24T21:20:01.596Z][TaskWorkflow/task-wf-${taskId}/run][${wf}] INFO: Starting invocation.`,
      `worker-green [restate][2026-09-24T21:20:01.778Z][TaskWorkflow/task-wf-${taskId}/run][${wf}] WARN: Error when processing ctx.run 'canva-verify-task-scope'.`,
      `worker-green [restate][2026-09-24T21:20:02.030Z][TaskWorkflow/task-wf-${taskId}/run][${wf}] INFO: Invocation completed successfully.`,
      `worker-green [restate][2026-09-24T21:20:03.100Z][TaskWorkflow/task-wf-${taskId}-redrive-1/run][${redrive}] INFO: Starting invocation.`,
      `worker-green [restate][2026-09-24T21:20:04.200Z][DesignRun/dr-${taskId}-a1/run][${design}] INFO: Invocation completed successfully.`,
      `worker-green [restate][2026-09-24T21:20:05.300Z][Delivery/dl-${taskId}-${approvalId}/run][${delivery}] INFO: Starting invocation.`,
      'worker-green [Delivery] files prepared',
      `worker-green [restate][2026-09-24T21:20:06.400Z][Delivery/dl-${taskId}-${approvalId}:archive:2/run][${archive}] INFO: Starting invocation.`,
    ]);
    // Without following, the invocation's own pino line (it never names the task) is not there.
    expect((await findRequestLines(wdir, taskId, { follow: false })).some((l) => l.log?.msg === '[Delivery] files prepared')).toBe(false);
  });

  it('does not take a prefix of the task id for the task', async () => {
    expect(await findRequestLines(wdir, taskId.slice(0, 23))).toEqual([]);
    expect(await findRequestLines(wdir, `task-wf-${taskId}`)).toHaveLength(3);
  });

  it('given an invocation id, finds its Restate lines and the lines logged under it', async () => {
    const lines = await findRequestLines(wdir, delivery);
    expect(lines.map((l) => l.message ?? l.log?.msg)).toEqual([
      `[restate][2026-09-24T21:20:05.300Z][Delivery/dl-${taskId}-${approvalId}/run][${delivery}] INFO: Starting invocation.`,
      '[Delivery] files prepared',
    ]);
  });

  it('the CLI given a task id shows the worker\'s lines, not Core\'s only', async () => {
    const err: string[] = [];
    expect(await runCli([taskId, '--dir', wdir], { out: () => {}, err: (s) => err.push(s) })).toBe(0);
    expect(err.at(-1)).toBe(`9 line(s) for ${taskId} in 2 file(s): core, worker-green`);
  });
});
