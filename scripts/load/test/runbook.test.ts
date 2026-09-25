import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The operations runbook of the new architecture (programme Phase 4). Every command in it was run by
 * its author on the chaos stack or the test server, never on production; each block says which on
 * its first line, and no block names production's containers, port or database. What differs on
 * production is said in the prose around the block, as a substitution.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNBOOK = path.join(root, 'runbooks', '20_architecture_operations.md');

function blocks(markdown: string): Array<{ lang: string; body: string; line: number }> {
  const out: Array<{ lang: string; body: string; line: number }> = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    out.push({ lang: open[1], body: body.join('\n'), line: start + 1 });
  }
  return out;
}

describe('runbooks/20_architecture_operations.md', () => {
  it('exists and covers each operation the programme names', () => {
    expect(existsSync(RUNBOOK)).toBe(true);
    const text = readFileSync(RUNBOOK, 'utf8');
    for (const topic of [
      /^## .*blue\/green/im,
      /^### .*stuck drain/im,
      /^## .*paused and backing-off invocations/im,
      /^## .*Phase 2 flags/im,
      /HAWA_TELEGRAM_POLLER/,
      /HAWA_LIFECYCLE_CHATS/,
      /HAWA_WORKER_TOKEN/,
      /^### .*roll(ing)? back/im,
      /^## .*one request's logs/im,
      /scripts\/request_logs\.ts/,
      /^## .*file store/im,
      /restore drill/i,
      /blob-gc/,
      /^## .*per-file test databases/im,
      /^## .*chaos suite/im,
      /^## .*load test/im,
    ]) {
      expect(text, `missing ${topic}`).toMatch(topic);
    }
  });

  it('says where each command block was run, and none targets production', () => {
    const text = readFileSync(RUNBOOK, 'utf8');
    const commands = blocks(text).filter((b) => b.lang === 'sh');
    expect(commands.length).toBeGreaterThan(10);
    for (const b of commands) {
      expect(b.body.split('\n')[0], `block at line ${b.line}`).toMatch(/^# Ran on the (chaos stack|test server)\b/);
      expect(b.body, `block at line ${b.line} names production`).not.toMatch(/hawa-production|54332|--apply|\/hawa\b(?!_)/);
    }
  });

  it('is linked from infra/docker/README.md', () => {
    expect(readFileSync(path.join(root, 'infra', 'docker', 'README.md'), 'utf8')).toMatch(/runbooks\/20_architecture_operations\.md/);
  });
});
