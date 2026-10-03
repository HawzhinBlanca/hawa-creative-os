/**
 * Fails when this checkout's ADR or migration numbers collide, leave a gap, or break the ADR blocks
 * (docs/NUMBERING.md). Reads only the files on disk, so it is cheap enough for `pnpm lint` and the
 * pre-commit hook; scripts/next_number.ts is the one that scans every branch and worktree.
 *
 *   tsx scripts/check_numbers.ts [--root <dir>] [--quiet]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from './numbering_lib.js';

export function main(argv: string[]): number {
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag >= 0 ? argv[rootFlag + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const quiet = argv.includes('--quiet');
  const { errors, warnings, notes } = checkTree(root);
  if (!quiet) {
    for (const w of warnings) console.log(`check_numbers: warn: ${w}`);
    for (const n of notes) console.log(`check_numbers: note: ${n}`);
  }
  for (const e of errors) console.error(`check_numbers: FAIL: ${e}`);
  if (errors.length) {
    console.error('check_numbers: take numbers with `tsx scripts/next_number.ts` (docs/NUMBERING.md)');
    return 1;
  }
  if (!quiet) console.log(`check_numbers: ok (${warnings.length} grandfathered, ${notes.length} reservations)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check_numbers: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
