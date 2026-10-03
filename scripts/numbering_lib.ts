/**
 * ADR and migration numbering shared by two agents on separate branches (docs/NUMBERING.md).
 *
 * Claude and Codex each picked "the highest number I can see, plus one" from their own checkout, and
 * took the same number repeatedly (ADR 140, 200, 256, 261-263, 285; migrations 023 and 069). A number
 * is now free only if no file carries it in the working tree, on any local or remote ref, or on disk
 * in any worktree of the repository (untracked files included). ADR numbers also come from a block
 * owned by one agent (adrs/NUMBER_BLOCKS.json); migrations are one shared sequence.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isForwardMigration } from '../packages/db/src/migration-files.js';

export type Kind = 'adr' | 'migration';
export const OWNERS = ['claude', 'codex'] as const;
export type Owner = (typeof OWNERS)[number];

export const DIRS: Record<Kind, string> = { adr: 'adrs', migration: 'packages/db/migrations' };
export const REGISTRY_PATH = 'adrs/NUMBER_BLOCKS.json';
/** In a reservation stub; check_numbers reports every stub still in the tree. */
export const RESERVATION_MARKER = 'number-reservation';

const NUMBERED = /^(\d{3,})_./;

export interface Block { owner: Owner; from: number; to: number; status?: string; note?: string }
export interface Registry {
  adr: {
    legacyBelow: number;
    ownerLineRequiredFrom: number;
    blocks: Block[];
    grandfathered: {
      duplicates: { number: number; files: string[]; note?: string }[];
      outOfBlock: { file: string; owner: Owner }[];
    };
  };
  migration: { appliedInProductionThrough: number };
}

export function readRegistry(root: string): Registry {
  const file = path.join(root, REGISTRY_PATH);
  if (!existsSync(file)) throw new Error(`${REGISTRY_PATH} is missing; it holds the ADR blocks (docs/NUMBERING.md)`);
  const registry = JSON.parse(readFileSync(file, 'utf8')) as Registry;
  for (const block of registry.adr.blocks) {
    if (!OWNERS.includes(block.owner) || !(block.from <= block.to)) throw new Error(`${REGISTRY_PATH}: bad block ${JSON.stringify(block)}`);
  }
  const blocks = [...registry.adr.blocks].sort((a, b) => a.from - b.from);
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].from <= blocks[i - 1].to) throw new Error(`${REGISTRY_PATH}: blocks ${blocks[i - 1].from}-${blocks[i - 1].to} and ${blocks[i].from}-${blocks[i].to} overlap`);
  }
  return registry;
}

export function numberOf(fileName: string): number | undefined {
  const m = NUMBERED.exec(fileName);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

export function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/** Files in a numbered directory that hold a number: every `NNN_` name for ADRs, every `.sql` (down files too) for migrations. */
function counts(kind: Kind, name: string): boolean {
  if (numberOf(name) === undefined) return false;
  return kind === 'adr' || name.endsWith('.sql');
}

function git(root: string, args: string[], input?: string): { status: number; stdout: Buffer } {
  // A hook exports GIT_DIR/GIT_INDEX_FILE for its own repository; the scan names its repository by -C.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  const result = spawnSync('git', ['-C', root, ...args], { input, env, maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout };
}

export interface Usage {
  /** number -> file name -> where it was seen (a ref name or a worktree path) */
  adr: Map<number, Map<string, Set<string>>>;
  migration: Map<number, Map<string, Set<string>>>;
  refs: number;
  worktrees: number;
}

function note(usage: Usage, kind: Kind, name: string, where: string): void {
  if (!counts(kind, name)) return;
  const n = numberOf(name)!;
  const byName = usage[kind].get(n) ?? new Map<string, Set<string>>();
  usage[kind].set(n, byName);
  const seen = byName.get(name) ?? new Set<string>();
  byName.set(name, seen);
  seen.add(where);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Entry names of git tree objects, read through one `git cat-file --batch`. */
function treeEntries(root: string, trees: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!trees.length) return out;
  const { stdout } = git(root, ['cat-file', '--batch'], trees.join('\n') + '\n');
  let at = 0;
  while (at < stdout.length) {
    const eol = stdout.indexOf(0x0a, at);
    if (eol < 0) break;
    const header = stdout.subarray(at, eol).toString('utf8').split(' ');
    at = eol + 1;
    if (header[1] !== 'tree') continue; // "<name> missing" has no body
    const [sha, , sizeText] = header;
    const size = Number(sizeText);
    const body = stdout.subarray(at, at + size);
    at += size + 1;
    const hashBytes = sha.length / 2;
    const names: string[] = [];
    let p = 0;
    while (p < body.length) {
      const space = body.indexOf(0x20, p);
      const nul = body.indexOf(0x00, space);
      names.push(body.subarray(space + 1, nul).toString('utf8'));
      p = nul + 1 + hashBytes;
    }
    out.set(sha, names);
  }
  return out;
}

/**
 * Every ADR and migration number in use: the working tree of `root`, every ref (branches, remote
 * branches, tags, stash, an agent's checkpoint refs), every worktree's HEAD, and the files on disk in
 * every worktree, whether committed or not.
 */
export function scanUsage(root: string): Usage {
  const usage: Usage = { adr: new Map(), migration: new Map(), refs: 0, worktrees: 0 };
  const revisions: { rev: string; where: string }[] = [];
  const refs = git(root, ['for-each-ref', '--format=%(refname)']);
  if (refs.status === 0) {
    for (const ref of refs.stdout.toString('utf8').split('\n').filter(Boolean)) {
      revisions.push({ rev: ref, where: ref });
      usage.refs++;
    }
  }
  const worktreePaths = new Set<string>([path.resolve(root)]);
  const listed = git(root, ['worktree', 'list', '--porcelain']);
  if (listed.status === 0) {
    let current = '';
    for (const line of listed.stdout.toString('utf8').split('\n')) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length);
        worktreePaths.add(path.resolve(current));
      } else if (line.startsWith('HEAD ')) {
        revisions.push({ rev: line.slice('HEAD '.length), where: `${current} (HEAD)` });
      }
    }
  }
  // One batch resolves each revision's two directories to tree ids; most refs share their trees.
  const queries = revisions.flatMap(({ rev, where }) => (['adr', 'migration'] as Kind[]).map((kind) => ({ q: `${rev}:${DIRS[kind]}`, kind, where })));
  if (queries.length) {
    const lines = git(root, ['cat-file', '--batch-check'], queries.map((x) => x.q).join('\n') + '\n').stdout.toString('utf8').split('\n');
    const byTree = new Map<string, { kind: Kind; where: string }[]>();
    queries.forEach((query, i) => {
      const m = /^([0-9a-f]{40,64}) tree \d+$/.exec(lines[i] ?? '');
      if (!m) return;
      const list = byTree.get(m[1]) ?? [];
      list.push({ kind: query.kind, where: query.where });
      byTree.set(m[1], list);
    });
    const entries = treeEntries(root, [...byTree.keys()]);
    for (const [tree, users] of byTree) {
      for (const name of entries.get(tree) ?? []) for (const { kind, where } of users) note(usage, kind, name, where);
    }
  }
  for (const worktree of worktreePaths) {
    if (!existsSync(worktree)) continue;
    usage.worktrees++;
    for (const kind of ['adr', 'migration'] as Kind[]) {
      for (const name of listDir(path.join(worktree, DIRS[kind]))) note(usage, kind, name, worktree);
    }
  }
  return usage;
}

export function blocksOf(registry: Registry, owner: Owner): Block[] {
  return registry.adr.blocks.filter((b) => b.owner === owner).sort((a, b) => a.from - b.from);
}

export function blockFor(registry: Registry, n: number): Block | undefined {
  return registry.adr.blocks.find((b) => n >= b.from && n <= b.to);
}

/**
 * The next ADR number for an owner: one past the highest number used anywhere inside the owner's
 * first unfinished block (a hole is never refilled: it may be a number someone used and dropped).
 */
export function nextAdr(registry: Registry, usage: Usage, owner: Owner): number {
  for (const block of blocksOf(registry, owner)) {
    let highest = block.from - 1;
    for (const n of usage.adr.keys()) if (n >= block.from && n <= block.to && n > highest) highest = n;
    if (highest < block.to) return highest + 1;
  }
  throw new Error(`every ${owner} ADR block in ${REGISTRY_PATH} is used up; add the next block there (docs/NUMBERING.md)`);
}

export function nextMigration(registry: Registry, usage: Usage): number {
  let highest = registry.migration.appliedInProductionThrough;
  for (const n of usage.migration.keys()) if (n > highest) highest = n;
  return highest + 1;
}

export function slugify(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('--title needs letters or digits');
  return slug;
}

export interface Reservation { number: number; file: string }

/**
 * Writes a stub for a free number into `root`. Commit it at once: the commit is what makes the
 * number visible on the other agent's next scan. A migration stub raises if it is ever run, so a
 * reservation can never be applied (and its checksum locked in) by a deploy.
 */
export function reserve(root: string, kind: Kind, n: number, title: string, owner: Owner | undefined, today = new Date().toISOString().slice(0, 10)): Reservation {
  const registry = readRegistry(root);
  const usage = scanUsage(root);
  const used = usage[kind].get(n);
  if (used) {
    const [name, where] = [...used.entries()][0];
    throw new Error(`${kind} ${pad(n)} is taken: ${name} on ${[...where][0]}`);
  }
  const slug = slugify(title);
  const words = slug.split('_').join(' ');
  let file: string;
  let body: string;
  if (kind === 'adr') {
    if (!owner) throw new Error('an ADR reservation needs --owner claude|codex');
    const block = blockFor(registry, n);
    if (!block || block.owner !== owner) throw new Error(`ADR ${pad(n)} is not in a ${owner} block of ${REGISTRY_PATH}`);
    file = path.join(DIRS.adr, `${pad(n)}_${slug}.md`);
    body = [
      `# ADR-${pad(n)}: ${words[0].toUpperCase()}${words.slice(1)} (reserved)`,
      '',
      `**Date:** ${today}`,
      `**Owner:** ${owner}`,
      `**Status:** Reserved. The number is held by \`scripts/next_number.ts --reserve\`; this stub is replaced by the decision.`,
      '',
      `<!-- ${RESERVATION_MARKER} -->`,
      '',
    ].join('\n');
  } else {
    const next = nextMigration(registry, usage);
    if (n !== next) throw new Error(`migrations are one gap-free sequence: the next is ${pad(next)}, not ${pad(n)}`);
    file = path.join(DIRS.migration, `${pad(n)}_${slug}.sql`);
    body = [
      `-- ${RESERVATION_MARKER}: migration ${pad(n)} reserved ${today}${owner ? ` by ${owner}` : ''} (scripts/next_number.ts).`,
      '-- It refuses to run, so a deploy that reaches it stops before recording a checksum. Replace this file',
      '-- with the migration before merging.',
      `DO $$ BEGIN RAISE EXCEPTION 'migration ${pad(n)} is a reservation stub, not a migration'; END $$;`,
      '',
    ].join('\n');
  }
  writeFileSync(path.join(root, file), body, { flag: 'wx' });
  return { number: n, file };
}

export interface CheckResult { errors: string[]; warnings: string[]; notes: string[] }

const OWNER_LINE = /^\W*Owner\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*`?([A-Za-z]+)/im;

export function declaredOwner(text: string): string | undefined {
  return OWNER_LINE.exec(text.split('\n').slice(0, 40).join('\n'))?.[1]?.toLowerCase();
}

/** The numbering rules over the files on disk in one checkout (fast: no git). */
export function checkTree(root: string): CheckResult {
  const result: CheckResult = { errors: [], warnings: [], notes: [] };
  const registry = readRegistry(root);
  const { legacyBelow, ownerLineRequiredFrom, grandfathered } = registry.adr;

  const adrs = listDir(path.join(root, DIRS.adr)).filter((f) => counts('adr', f)).sort();
  const adrByNumber = new Map<number, string[]>();
  for (const f of adrs) adrByNumber.set(numberOf(f)!, [...(adrByNumber.get(numberOf(f)!) ?? []), f]);
  for (const [n, files] of adrByNumber) {
    if (files.length < 2) continue;
    const known = grandfathered.duplicates.find((d) => d.number === n && files.every((f) => d.files.includes(f)));
    if (known) result.warnings.push(`ADR ${pad(n)} is shared by ${files.join(' and ')} (grandfathered)`);
    else result.errors.push(`ADR ${pad(n)} is shared by ${files.join(' and ')}; renumber the newer one with scripts/next_number.ts`);
  }
  for (const f of adrs) {
    const n = numberOf(f)!;
    const text = readFileSync(path.join(root, DIRS.adr, f), 'utf8');
    if (text.includes(RESERVATION_MARKER)) result.notes.push(`${DIRS.adr}/${f} is a reservation stub`);
    if (n < legacyBelow) continue;
    const historical = grandfathered.outOfBlock.find((g) => g.file === f);
    const block = blockFor(registry, n);
    const owner = declaredOwner(text);
    if (historical) {
      result.warnings.push(`${DIRS.adr}/${f} is ${historical.owner}'s, in ${block ? `${block.owner}'s block ${block.from}-${block.to}` : 'no block'} (grandfathered)`);
      continue;
    }
    if (!block) {
      result.errors.push(`${DIRS.adr}/${f}: ${pad(n)} is in no block of ${REGISTRY_PATH}; take a number with scripts/next_number.ts adr --owner <you>`);
    } else if (owner && owner !== block.owner) {
      result.errors.push(`${DIRS.adr}/${f} declares owner ${owner} but ${pad(n)} is in ${block.owner}'s block ${block.from}-${block.to}`);
    } else if (!owner && n >= ownerLineRequiredFrom) {
      result.errors.push(`${DIRS.adr}/${f} has no "**Owner:** ${block.owner}" line (required from ADR ${ownerLineRequiredFrom}, docs/NUMBERING.md)`);
    }
  }

  const sqlFiles = listDir(path.join(root, DIRS.migration)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of sqlFiles) {
    if (numberOf(f) === undefined || !/^\d{3}_/.test(f)) result.errors.push(`${DIRS.migration}/${f} is not NNN_name.sql; the migration runner would skip it`);
  }
  const forward = sqlFiles.filter(isForwardMigration);
  const migByNumber = new Map<number, string[]>();
  for (const f of forward) migByNumber.set(numberOf(f)!, [...(migByNumber.get(numberOf(f)!) ?? []), f]);
  for (const [n, files] of migByNumber) {
    if (files.length > 1) result.errors.push(`migration ${pad(n)} is shared by ${files.join(' and ')}`);
  }
  const numbers = [...migByNumber.keys()].sort((a, b) => a - b);
  if (numbers[0] === 0) result.errors.push('migration 000 exists; the sequence starts at 001');
  const missing: number[] = [];
  for (let i = 1; i <= (numbers.at(-1) ?? 0); i++) if (!migByNumber.has(i)) missing.push(i);
  if (missing.length) result.errors.push(`migration sequence has a gap: ${missing.map(pad).join(', ')} missing (discoverMigrations refuses it)`);
  for (const f of forward) {
    if (readFileSync(path.join(root, DIRS.migration, f), 'utf8').includes(RESERVATION_MARKER)) {
      result.notes.push(`${DIRS.migration}/${f} is a reservation stub; write the migration before merging`);
    }
  }
  return result;
}
