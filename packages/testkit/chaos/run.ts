#!/usr/bin/env tsx
/**
 * Runs the chaos suite, or takes a kept project down.
 *
 *   npx tsx packages/testkit/chaos/run.ts                 # every scenario, then tear down
 *   npx tsx packages/testkit/chaos/run.ts --keep          # leave hawa-chaos running afterwards
 *   npx tsx packages/testkit/chaos/run.ts --only R1.0,R4  # some scenarios
 *   npx tsx packages/testkit/chaos/run.ts --down          # take a kept project down (with its volumes)
 *
 * The scenarios are chaos.test.ts (vitest); this sets HAWA_CHAOS and friends and runs it alone.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, down } from './driver/stack.js';

const args = process.argv.slice(2);
if (args.includes('--down')) {
  down({ volumes: true });
  console.log('hawa-chaos is down; its volumes and throwaway secrets are gone.');
  process.exit(0);
}
const onlyAt = args.indexOf('--only');
const env = {
  ...process.env,
  HAWA_CHAOS: '1',
  ...(args.includes('--keep') ? { HAWA_CHAOS_KEEP: '1' } : {}),
  ...(onlyAt >= 0 && args[onlyAt + 1] ? { HAWA_CHAOS_ONLY: args[onlyAt + 1] } : {}),
  // The Mac also runs the office: one test file, one worker.
  HAWA_TEST_WORKERS: '1',
};
const res = spawnSync('npx', ['vitest', 'run', join('packages', 'testkit', 'chaos', 'chaos.test.ts')], { cwd: REPO_ROOT, env, stdio: 'inherit' });
console.log(`Results: ${join('packages', 'testkit', 'chaos', '.run', 'last-run.json')}`);
process.exit(res.status ?? 1);
