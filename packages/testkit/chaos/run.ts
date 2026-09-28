#!/usr/bin/env tsx
/**
 * Runs the chaos suite, or takes a kept project down.
 *
 *   npx tsx packages/testkit/chaos/run.ts                 # every scenario, then tear down
 *   npx tsx packages/testkit/chaos/run.ts --keep          # leave hawa-chaos running afterwards
 *   npx tsx packages/testkit/chaos/run.ts --only R1.0,R4  # some scenarios
 *   npx tsx packages/testkit/chaos/run.ts --down          # take a kept project down (with its volumes)
 *   npx tsx packages/testkit/chaos/run.ts --poller worker # the worker polls Telegram (Phase 2.1)
 *   npx tsx packages/testkit/chaos/run.ts --poller core --lifecycle-chats none --only R10.H1,R10.K1,R10.K2
 *                                                   # the 2026-09-28 cutover and its rollback (ADR-136)
 *
 * The scenarios are chaos.test.ts (vitest); this sets HAWA_CHAOS and friends and runs it alone.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, acquireProject, down, releaseProject } from './driver/stack.js';

const args = process.argv.slice(2);
if (args.includes('--recovery') && !args.includes('--candidate')) {
  console.error('--recovery requires the isolated --candidate rehearsal');
  process.exit(2);
}
if (args.includes('--down')) {
  // Refuses (does not wait) while a run holds the project: it would take that run's stack away.
  await acquireProject({ waitMs: 0 });
  down({ volumes: true });
  await releaseProject();
  console.log('hawa-chaos is down; its volumes and throwaway secrets are gone.');
  process.exit(0);
}
if (args.includes('--candidate') && (args[args.indexOf('--only') + 1] !== 'R1.S3.SOURCES' || !args.includes('--poller') || args[args.indexOf('--poller') + 1] !== 'worker')) {
  console.error('--candidate requires --only R1.S3.SOURCES and --poller worker');
  process.exit(2);
}
const onlyAt = args.indexOf('--only');
const pollerAt = args.indexOf('--poller');
if (pollerAt >= 0 && !['core', 'worker'].includes(args[pollerAt + 1] ?? '')) {
  console.error('--poller takes core or worker');
  process.exit(2);
}
const chatsAt = args.indexOf('--lifecycle-chats');
if (chatsAt >= 0 && !/^(none|\*|\d+(,\d+)*)$/.test(args[chatsAt + 1] ?? '')) {
  console.error('--lifecycle-chats takes chat ids, * or none');
  process.exit(2);
}
const env = {
  ...process.env,
  HAWA_CHAOS: '1',
  CHAOS_BUILD_COMMIT: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  ...(args.includes('--candidate') ? { HAWA_CHAOS_CANDIDATE: '1', CHAOS_DOCLING_URL: 'http://docling:8091' } : {}),
  ...(args.includes('--recovery') ? { HAWA_CHAOS_RECOVERY: '1', CHAOS_PG_FSYNC: 'on', CHAOS_PG_FULL_PAGE_WRITES: 'on' } : {}),
  ...(args.includes('--keep') ? { HAWA_CHAOS_KEEP: '1' } : {}),
  ...(onlyAt >= 0 && args[onlyAt + 1] ? { HAWA_CHAOS_ONLY: args[onlyAt + 1] } : {}),
  // Who polls Telegram in the stack: core (as production today) or worker (Phase 2.1). Compose reads
  // it from this environment (docker-compose.chaos.yml); the scenarios read it to know which apply.
  ...(pollerAt >= 0 && args[pollerAt + 1] ? { CHAOS_TELEGRAM_POLLER: args[pollerAt + 1] } : {}),
  // HAWA_LIFECYCLE_CHATS of Core and the workers at start: chat ids, `*`, or `none` (set but empty,
  // as production before 2026-09-28). Without it the compose file's list of flagged chats applies.
  ...(chatsAt >= 0 ? { CHAOS_LIFECYCLE_CHATS: args[chatsAt + 1] === 'none' ? '' : String(args[chatsAt + 1] ?? '') } : {}),
  // The Mac also runs the office: one test file, one worker.
  HAWA_TEST_WORKERS: '1',
};
const res = spawnSync('npx', ['vitest', 'run', join('packages', 'testkit', 'chaos', 'chaos.test.ts')], { cwd: REPO_ROOT, env, stdio: 'inherit' });
console.log(`Results: ${join('packages', 'testkit', 'chaos', '.run', 'last-run.json')}`);
process.exit(res.status ?? 1);
