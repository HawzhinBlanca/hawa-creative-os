import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-141: `python3 -m pytest infra/backup` run from the repository root leaves .pytest_cache there.
 * The main checkout's manifest refresh recorded its four files in MANIFEST.json and SHA256SUMS.txt, so
 * a fresh clone, which has no cache, failed validate_pack.py ("manifest target exists"), and deploy.sh
 * step 4 with it. Tool caches are never package files. The fresh-clone check itself is in
 * plans/hosting/LINUX_READINESS_PROOF.json.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// validate_pack.py needs PyYAML; not every python3 on a developer PATH has it.
const python = ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']
  .find((p) => spawnSync(p, ['-c', 'import yaml'], { stdio: 'ignore' }).status === 0) ?? 'python3';

describe('validate_pack.py and tool caches', () => {
  it('skips pytest, mypy and ruff caches anywhere, and still counts real documents', () => {
    const out = execFileSync(python, ['-c', [
      'import sys; sys.path.insert(0, "scripts")',
      'from validate_pack import should_skip, ROOT',
      'for p in (".pytest_cache/v/cache/nodeids", "infra/backup/.pytest_cache/README.md", "docs/.mypy_cache/x", ".ruff_cache/y", "docs/25_OPERATIONS_RUNBOOK.md", "runbooks/10_backup_restore.md"):',
      '    print(p, should_skip(ROOT / p))',
    ].join('\n')], { cwd: repo, encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual([
      '.pytest_cache/v/cache/nodeids True', 'infra/backup/.pytest_cache/README.md True', 'docs/.mypy_cache/x True',
      '.ruff_cache/y True', 'docs/25_OPERATIONS_RUNBOOK.md False', 'runbooks/10_backup_restore.md False',
    ]);
  });

  it('the committed manifest lists only tracked files', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'MANIFEST.json'), 'utf8')) as { files: Array<{ path: string }> };
    const tracked = new Set(execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n'));
    const untracked = manifest.files.map((f) => f.path).filter((p) => !tracked.has(p));
    expect(untracked).toEqual([]);
  });
});
