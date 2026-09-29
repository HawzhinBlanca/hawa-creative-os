#!/usr/bin/env tsx
/**
 * Runs the chaos suite, or takes a kept project down.
 *
 *   npx tsx packages/testkit/chaos/run.ts                 # every scenario, then tear down
 *   npx tsx packages/testkit/chaos/run.ts --keep          # leave hawa-chaos running afterwards
 *   npx tsx packages/testkit/chaos/run.ts --only R1.0,R4  # some scenarios
 *   npx tsx packages/testkit/chaos/run.ts --only R1.K0 --repeat 3   # one scenario three times
 *   npx tsx packages/testkit/chaos/run.ts --down          # take a kept project down (with its volumes)
 *   npx tsx packages/testkit/chaos/run.ts --poller worker # the worker polls Telegram (the only poller since ADR-135)
 *   npx tsx packages/testkit/chaos/run.ts --seed-dump infra/backup/snapshots/predeploy_<stamp>.dump
 *                                        # on a copy of production's data (driver/seed.ts, ADR-137)
 *   npx tsx packages/testkit/chaos/run.ts --only R10.K1,R10.K2 [--previous-release <commit>]
 *                                        # old requests after this release's deploy, and rolling it back
 *                                        # to the previous release (default: RELEASE_MANIFEST.json's build)
 *
 * The scenarios are chaos.test.ts (vitest); this sets HAWA_CHAOS and friends and runs it alone.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const seedAt = args.indexOf('--seed-dump');
const seedDump = seedAt >= 0 ? resolve(process.cwd(), args[seedAt + 1] ?? '') : '';
if (seedAt >= 0 && (!args[seedAt + 1] || !existsSync(seedDump))) {
  console.error('--seed-dump takes an existing pg_dump -Fc file (infra/backup/snapshots/predeploy_*.dump)');
  process.exit(2);
}
if (seedAt >= 0 && args.includes('--candidate')) {
  console.error('--seed-dump is not combined with the --candidate rehearsal');
  process.exit(2);
}
if (args.includes('--lifecycle-chats')) {
  console.error('--lifecycle-chats is gone: every chat is lifecycle-owned (ADR-135)');
  process.exit(2);
}
const repeatAt = args.indexOf('--repeat');
if (repeatAt >= 0 && !/^(10|[1-9])$/.test(args[repeatAt + 1] ?? '')) {
  console.error('--repeat takes a count from 1 to 10');
  process.exit(2);
}
const previousAt = args.indexOf('--previous-release');
if (previousAt >= 0 && !/^[0-9a-f]{7,40}$/.test(args[previousAt + 1] ?? '')) {
  console.error('--previous-release takes a commit (7 to 40 hex digits)');
  process.exit(2);
}
const onlyAt = args.indexOf('--only');
const pollerAt = args.indexOf('--poller');
// ADR-135: Core no longer polls Telegram, so the only stack left to test is the worker's poller.
if (pollerAt >= 0 && args[pollerAt + 1] !== 'worker') {
  console.error('--poller takes worker only: Core no longer polls Telegram (ADR-135)');
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
  // Who polls Telegram in the stack: the worker, always (ADR-135; docker-compose.chaos.yml).
  CHAOS_TELEGRAM_POLLER: 'worker',
  // A copy of production's data under the scenarios (driver/seed.ts); compose never sees the path.
  ...(seedDump ? { HAWA_CHAOS_SEED_DUMP: seedDump } : {}),
  // Each selected scenario this many times (chaos.test.ts), for a flaky one's repeat evidence.
  ...(repeatAt >= 0 ? { HAWA_CHAOS_REPEAT: args[repeatAt + 1] } : {}),
  // The release R10 starts from and rolls back to (driver/cutover.ts buildPreviousRelease).
  ...(previousAt >= 0 ? { HAWA_CHAOS_PREVIOUS_RELEASE: args[previousAt + 1] } : {}),
  // The Mac also runs the office: one test file, one worker.
  HAWA_TEST_WORKERS: '1',
};
const res = spawnSync('npx', ['vitest', 'run', join('packages', 'testkit', 'chaos', 'chaos.test.ts')], { cwd: REPO_ROOT, env, stdio: 'inherit' });
console.log(`Results: ${join('packages', 'testkit', 'chaos', '.run', 'last-run.json')}`);
process.exit(res.status ?? 1);
