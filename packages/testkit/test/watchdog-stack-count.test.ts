import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * infra/ops/watchdog.sh restarts the stack and alerts when one of its six services is down. The
 * Vector service (architecture programme 1.4) is a seventh container: counted with the six, it hid a
 * dead desk or cutout, and its own death went unnoticed (1.4 review). The watchdog's container
 * checks live in infra/ops/stack_containers.sh, which this test sources with a fixed container list.
 */
const helper = path.resolve(import.meta.dirname, '../../../infra/ops/stack_containers.sh');

function check(names: string[]): { stack: number; missing: string; workers: number; vector: string } {
  const script = [
    // As strict as watchdog.sh, whose launch agent runs it with the system bash (3.2 on macOS).
    'set -Eeuo pipefail',
    `running_names() { printf '%s\\n' ${names.map((n) => `'${n}'`).join(' ')}; }`,
    `source '${helper}'`,
    'echo "stack=$(count_stack)"',
    'echo "missing=$(missing_stack)"',
    'echo "workers=$(count_workers)"',
    'if vector_running; then echo vector=up; else echo vector=down; fi',
  ].join('\n');
  const out = execFileSync(fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', ['-c', script], { encoding: 'utf8' });
  const get = (key: string) => /^(.*)$/m.exec(out.split('\n').find((l) => l.startsWith(`${key}=`))!.slice(key.length + 1))![1];
  return { stack: Number(get('stack')), missing: get('missing'), workers: Number(get('workers')), vector: get('vector') };
}

const all = ['nginx', 'desk', 'core', 'cutout', 'postgres', 'restate'].map((s) => `hawa-production-${s}-1`);

describe('the watchdog\'s container checks', () => {
  it('counts a stack with a dead desk as short, even while Vector runs', () => {
    const names = [...all.filter((n) => !n.includes('desk')), 'hawa-production-vector-1', 'hawa-production-worker-blue-1'];
    expect(check(names)).toEqual({ stack: 5, missing: 'desk', workers: 1, vector: 'up' });
  });

  it('notices a dead Vector while the six services and a worker run', () => {
    expect(check([...all, 'hawa-production-worker-green-1'])).toEqual({ stack: 6, missing: '', workers: 1, vector: 'down' });
  });

  it('reports a full stack with Vector as healthy', () => {
    expect(check([...all, 'hawa-production-vector-1', 'hawa-production-worker-1'])).toEqual({ stack: 6, missing: '', workers: 1, vector: 'up' });
  });
});
