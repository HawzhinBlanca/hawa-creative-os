import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTree, nextAdr, nextMigration, readRegistry, reserve, scanUsage } from '../numbering_lib.js';

/**
 * ADR and migration numbering across agents (docs/NUMBERING.md): a number used on any branch or in
 * any worktree, even uncommitted, is never offered again, and the checkout's own numbers are checked.
 */
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];

const REGISTRY = {
  adr: {
    legacyBelow: 270,
    ownerLineRequiredFrom: 272,
    blocks: [
      { owner: 'claude', from: 270, to: 299 },
      { owner: 'codex', from: 300, to: 399 },
      { owner: 'claude', from: 400, to: 499 },
    ],
    grandfathered: {
      duplicates: [{ number: 200, files: ['200_a.md', '200_b.md'] }],
      outOfBlock: [{ file: '276_codex_in_claude_block.md', owner: 'codex' }],
    },
  },
  migration: { appliedInProductionThrough: 2 },
};

function repo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-numbering-'));
  temps.push(base);
  const dir = path.join(base, 'main');
  fs.mkdirSync(path.join(dir, 'adrs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages/db/migrations'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (file: string, text = `# ${file}\n\n**Owner:** claude\n`, root = dir) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const commit = (file: string, text?: string) => {
    write(file, text);
    git('add', file);
    git('commit', '-q', '-m', `add ${file}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  commit('adrs/NUMBER_BLOCKS.json', JSON.stringify(REGISTRY));
  commit('packages/db/migrations/001_first.sql', 'select 1;\n');
  commit('packages/db/migrations/002_second.sql', 'select 2;\n');
  return { base, dir, git, write, commit };
}

const next = (root: string) => {
  const registry = readRegistry(root);
  const usage = scanUsage(root);
  return { claude: nextAdr(registry, usage, 'claude'), codex: nextAdr(registry, usage, 'codex'), migration: nextMigration(registry, usage) };
};

describe('next_number', () => {
  it('starts each owner at its block and the migrations past production', () => {
    const r = repo();
    expect(next(r.dir)).toEqual({ claude: 270, codex: 300, migration: 3 });
  });

  it('never offers a number committed only on another branch', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'codex/feature');
    r.commit('adrs/270_codex_took_it.md');
    r.commit('packages/db/migrations/003_codex_migration.sql', 'select 3;\n');
    r.git('checkout', '-q', 'main');
    expect(fs.existsSync(path.join(r.dir, 'adrs/270_codex_took_it.md'))).toBe(false);
    expect(next(r.dir)).toMatchObject({ claude: 271, migration: 4 });
  });

  it('sees a remote-tracking branch and a hole is never refilled', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'side');
    r.commit('adrs/275_far_ahead.md');
    r.git('update-ref', 'refs/remotes/origin/side', 'HEAD');
    r.git('checkout', '-q', 'main');
    r.git('branch', '-q', '-D', 'side');
    expect(next(r.dir).claude).toBe(276);
  });

  it('never offers a number held by an untracked file in another worktree', () => {
    const r = repo();
    const other = path.join(r.base, 'other');
    r.git('worktree', 'add', '-q', '-b', 'claude/other', other);
    r.write('adrs/270_uncommitted_draft.md', '# draft\n', other);
    r.write('packages/db/migrations/003_uncommitted.sql', 'select 3;\n', other);
    expect(next(r.dir)).toMatchObject({ claude: 271, migration: 4 });
    // and the other worktree sees the main checkout's untracked files the same way
    r.write('adrs/271_main_draft.md');
    expect(next(other).claude).toBe(272);
  });

  it('reserves a number with a stub that the next scan and the check both see', () => {
    const r = repo();
    const held = reserve(r.dir, 'adr', 270, 'Deploy Keeps Live Release', 'claude', '2026-10-03');
    expect(held.file).toBe(path.join('adrs', '270_deploy_keeps_live_release.md'));
    const text = fs.readFileSync(path.join(r.dir, held.file), 'utf8');
    expect(text).toContain('**Owner:** claude');
    expect(text.length).toBeGreaterThan(100);
    expect(next(r.dir).claude).toBe(271);
    expect(checkTree(r.dir)).toMatchObject({ errors: [], notes: [expect.stringContaining('270_deploy_keeps_live_release.md is a reservation stub')] });

    expect(() => reserve(r.dir, 'adr', 270, 'again', 'claude')).toThrow(/taken/);
    expect(() => reserve(r.dir, 'adr', 300, 'not mine', 'claude')).toThrow(/not in a claude block/);
    expect(() => reserve(r.dir, 'migration', 5, 'skips', undefined)).toThrow(/next is 003/);

    const migration = reserve(r.dir, 'migration', 3, 'customer table', 'codex', '2026-10-03');
    expect(fs.readFileSync(path.join(r.dir, migration.file), 'utf8')).toMatch(/RAISE EXCEPTION 'migration 003 is a reservation stub/);
    expect(next(r.dir).migration).toBe(4);
  });

  it('prints only the number on stdout', () => {
    const r = repo();
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/next_number.ts'), 'adr', '--owner', 'codex', '--root', r.dir], { encoding: 'utf8', env });
    expect(run.stderr).toContain('next free');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('300\n');
  });
});

describe('check_numbers', () => {
  it('fails a migration gap and ignores _down.sql files', () => {
    const r = repo();
    r.write('packages/db/migrations/001_first_down.sql', 'drop table x;\n');
    expect(checkTree(r.dir).errors).toEqual([]);
    r.write('packages/db/migrations/004_after_a_gap.sql', 'select 4;\n');
    expect(checkTree(r.dir).errors).toEqual([expect.stringContaining('gap: 003 missing')]);
    r.write('packages/db/migrations/003_fills_it.sql', 'select 3;\n');
    expect(checkTree(r.dir).errors).toEqual([]);
    r.write('packages/db/migrations/003_twice.sql', 'select 3;\n');
    expect(checkTree(r.dir).errors).toEqual([expect.stringContaining('migration 003 is shared')]);
  });

  it('fails a migration name the runner would skip', () => {
    const r = repo();
    r.write('packages/db/migrations/03_short.sql', 'select 3;\n');
    expect(checkTree(r.dir).errors).toEqual([expect.stringContaining('03_short.sql is not NNN_name.sql')]);
  });

  it('passes grandfathered duplicates and out-of-block files, and fails new ones', () => {
    const r = repo();
    r.write('adrs/200_a.md');
    r.write('adrs/200_b.md');
    r.write('adrs/150_legacy_without_owner.md', '# old\n');
    r.write('adrs/276_codex_in_claude_block.md', '# codex\n\n**Owner:** codex\n');
    r.write('adrs/271_before_owner_lines.md', '# no owner line, grandfathered by number\n');
    const ok = checkTree(r.dir);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([
      expect.stringContaining('ADR 200 is shared by 200_a.md and 200_b.md (grandfathered)'),
      expect.stringContaining("276_codex_in_claude_block.md is codex's, in claude's block 270-299"),
    ]);

    r.write('adrs/201_x.md');
    r.write('adrs/201_y.md');
    r.write('adrs/277_codex_again.md', '# x\n\n**Owner:** codex\n');
    r.write('adrs/278_no_owner.md', '# x\n');
    r.write('adrs/500_outside.md');
    r.write('adrs/301_codex.md', '# x\n\nOwner: codex\n');
    const bad = checkTree(r.dir).errors;
    expect(bad).toEqual([
      expect.stringContaining('ADR 201 is shared by 201_x.md and 201_y.md'),
      expect.stringContaining("277_codex_again.md declares owner codex but 277 is in claude's block"),
      expect.stringContaining('278_no_owner.md has no "**Owner:** claude" line'),
      expect.stringContaining('500 is in no block'),
    ]);
  });

  it('passes on this checkout', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/check_numbers.ts')], { encoding: 'utf8', env });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('check_numbers: ok');
  });
});
