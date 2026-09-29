import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Vector writes container logs to ~/.hawa/logs/containers/<day>/ and never deletes them;
 * infra/ops/disk_cleanup.sh keeps 30 days and, since Vector caps no size the way Docker's driver did,
 * drops the oldest days once the rest pass a ceiling (1.4 review). The function is run on its own,
 * cut from the script, so the test touches no dump and no Docker state.
 */
const script = path.resolve(import.meta.dirname, '../../../infra/ops/disk_cleanup.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-log-prune-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
function fill(name: string, mb: number) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'core.ndjson'), Buffer.alloc(mb * 1024 * 1024, 'x'));
}

function prune(days: number, maxMb: number): string {
  const body = [
    'set -Eeuo pipefail',
    // The date some days ago comes from infra/ops/host_lib.sh (BSD or GNU date, ADR-141).
    `source '${path.resolve(import.meta.dirname, '../../../infra/ops/host_lib.sh')}'`,
    `eval "$(sed -n '/^prune_container_logs() {/,/^}/p' '${script}')"`,
    `prune_container_logs '${dir}' ${days} ${maxMb}`,
  ].join('\n');
  return execFileSync(fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', ['-c', body], { encoding: 'utf8' });
}

describe('the container log prune', () => {
  it('drops days past retention, then the oldest days until the rest fit, never today or other files', () => {
    fill(day(40), 1);
    fill(day(3), 2);
    fill(day(2), 2);
    fill(day(0), 2);
    fs.mkdirSync(path.join(dir, 'notes'));
    const out = prune(30, 5);
    expect(fs.readdirSync(dir).sort()).toEqual([day(2), day(0), 'notes'].sort());
    expect(out).toContain(`removed ${day(3)}`);

    // A single day over the ceiling is today's: it stays, for the operator to read.
    prune(30, 1);
    expect(fs.readdirSync(dir).sort()).toEqual([day(0), 'notes'].sort());
  });
});
