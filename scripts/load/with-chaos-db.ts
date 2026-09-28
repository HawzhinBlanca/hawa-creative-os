#!/usr/bin/env tsx
/**
 * Runs a command with the chaos database's owner URL in its environment, for rehearsing operations
 * tools on the chaos stack (runbooks/20_architecture_operations.md) without the password appearing
 * on a command line, in a shell history or on screen:
 *
 *   npx tsx scripts/load/with-chaos-db.ts <command> [args…]
 *
 * Sets DATABASE_URL and HAWA_DRILL_DATABASE_URL to the owner of 127.0.0.1:56432/hawa_chaos, from the
 * chaos driver's throwaway secrets (packages/testkit/chaos/.run/chaos.env, written when the project
 * starts). The URL is checked by assertChaosDatabaseUrl before anything runs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChaosDatabaseUrl } from './load-stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = path.join(ROOT, 'packages', 'testkit', 'chaos', '.run', 'chaos.env');

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: with-chaos-db.ts <command> [args…]');
  process.exit(64);
}
if (!existsSync(ENV_FILE)) {
  console.error('no chaos project: packages/testkit/chaos/.run/chaos.env is missing (start the chaos stack first)');
  process.exit(2);
}
const password = /^CHAOS_OWNER_PASSWORD=(.+)$/m.exec(readFileSync(ENV_FILE, 'utf8'))?.[1]?.trim();
if (!password) {
  console.error('CHAOS_OWNER_PASSWORD is not in the chaos env file');
  process.exit(2);
}
const url = `postgresql://hawa_owner:${password}@127.0.0.1:56432/hawa_chaos`;
assertChaosDatabaseUrl(url);
const res = spawnSync(command, args, { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url, HAWA_DRILL_DATABASE_URL: url } });
process.exit(res.status ?? 1);
