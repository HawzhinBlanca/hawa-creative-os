/**
 * Prints the next free ADR or migration number (docs/NUMBERING.md).
 *
 *   tsx scripts/next_number.ts adr --owner claude|codex
 *   tsx scripts/next_number.ts migration
 *   tsx scripts/next_number.ts adr --owner claude --reserve next|<n> --title <slug>
 *   tsx scripts/next_number.ts migration --reserve next|<n> --title <slug> [--owner <you>]
 *
 * "Free" means no file with that number in this working tree, on any ref (local and remote branches,
 * tags, stash, checkpoint refs) or on disk in any worktree. `git fetch` first to see the other agent's
 * pushed branches. The number alone goes to stdout; how it was found goes to stderr.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blocksOf, nextAdr, nextMigration, OWNERS, pad, readRegistry, reserve, scanUsage, type Kind, type Owner,
} from './numbering_lib.js';

function usage(message: string): never {
  console.error(`${message}\nusage: next_number.ts adr --owner claude|codex | migration  [--reserve next|<n> --title <slug>] [--root <dir>]`);
  process.exit(2);
}

export function main(argv: string[]): void {
  const [kindArg, ...rest] = argv;
  if (kindArg !== 'adr' && kindArg !== 'migration') usage('first argument must be adr or migration');
  const kind: Kind = kindArg;
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!['--owner', '--reserve', '--title', '--root'].includes(flag) || rest[i + 1] === undefined) usage(`bad option ${flag}`);
    options[flag.slice(2)] = rest[i + 1];
  }
  const owner = options.owner as Owner | undefined;
  if (owner !== undefined && !OWNERS.includes(owner)) usage(`--owner must be one of ${OWNERS.join(', ')}`);
  if (kind === 'adr' && !owner) usage('adr needs --owner');
  if ((options.reserve === undefined) !== (options.title === undefined)) usage('--reserve and --title go together');

  const root = options.root ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const registry = readRegistry(root);
  const scan = scanUsage(root);
  const next = kind === 'adr' ? nextAdr(registry, scan, owner!) : nextMigration(registry, scan);
  const where = kind === 'adr'
    ? `${owner}'s blocks ${blocksOf(registry, owner!).map((b) => `${b.from}-${b.to}`).join(', ')}`
    : `shared sequence, production through ${pad(registry.migration.appliedInProductionThrough)}`;
  console.error(`scanned ${scan.refs} refs and ${scan.worktrees} worktrees; ${kind} next free in ${where}: ${pad(next)}`);

  if (options.reserve === undefined) {
    console.log(pad(next));
    return;
  }
  const n = options.reserve === 'next' ? next : Number.parseInt(options.reserve, 10);
  if (!Number.isInteger(n) || n <= 0) usage('--reserve takes next or a number');
  const held = reserve(root, kind, n, options.title, owner);
  console.error(`reserved ${kind} ${pad(held.number)}: ${held.file}. Commit it now so the other agent's scan sees it.`);
  console.log(held.file);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
