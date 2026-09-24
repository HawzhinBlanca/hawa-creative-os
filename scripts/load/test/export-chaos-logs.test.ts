import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRequestLines } from '../../request_logs.js';
import { toVectorLines, writeVectorFiles } from '../export-chaos-logs.js';

const coreText = [
  '2026-09-24T21:03:32.123456789Z {"level":"info","time":"2026-09-24T21:03:32.123Z","service":"core","requestId":"req-abc123","method":"GET","path":"/v1/tasks","status":200,"ms":12,"msg":"request"}',
  '2026-09-24T21:03:33.000000001Z plain text line',
  '',
  '2026-09-25T00:00:01.000000000Z {"level":"info","requestId":"req-abc123","msg":"after midnight"}',
].join('\n');

describe('toVectorLines', () => {
  it('writes each docker log line as Vector does: the JSON object under log, text under message', () => {
    const lines = toVectorLines('core', 'hawa-chaos-core-1', coreText);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      timestamp: '2026-09-24T21:03:32.123456789Z', service: 'core', container_name: 'hawa-chaos-core-1',
      log: { level: 'info', time: '2026-09-24T21:03:32.123Z', service: 'core', requestId: 'req-abc123', method: 'GET', path: '/v1/tasks', status: 200, ms: 12, msg: 'request' },
    });
    expect(lines[1]).toEqual({ timestamp: '2026-09-24T21:03:33.000000001Z', service: 'core', container_name: 'hawa-chaos-core-1', message: 'plain text line' });
  });

  it('refuses a container outside the chaos project', () => {
    expect(() => toVectorLines('core', 'hawa-production-core-1', coreText)).toThrow(/hawa-chaos/);
  });
});

describe('writeVectorFiles', () => {
  it('lays the lines out as <dir>/<UTC day>/<service>.ndjson, which scripts/request_logs.ts reads', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hawa-chaos-logs-'));
    writeVectorFiles(dir, toVectorLines('core', 'hawa-chaos-core-1', coreText));
    expect(readdirSync(dir).sort()).toEqual(['2026-09-24', '2026-09-25']);
    expect(readFileSync(path.join(dir, '2026-09-24', 'core.ndjson'), 'utf8').trim().split('\n')).toHaveLength(2);
    const found = await findRequestLines(dir, 'req-abc123');
    expect(found.map((l) => l.log?.msg)).toEqual(['request', 'after midnight']);
  });
});
