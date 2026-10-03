import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-281: plans/…/DESK_AUDIT_FIXES.md linked into output/audits/, which is git-ignored. The link
 * resolved on the checkouts that had a hand-copied output/audits, so validate_pack.py passed there,
 * and failed Gate A on every clean clone and CI runner. A committed document's link into a
 * git-ignored path is now refused on every checkout, whether or not the local copy exists.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const python = ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']
  .find((p) => spawnSync(p, ['-c', 'import yaml'], { stdio: 'ignore' }).status === 0) ?? 'python3';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-pack-links-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function put(rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function problems(root: string): { broken: string[]; ignored: string[]; warnings: string[] } {
  const out = execFileSync(python, ['-c', [
    'import json, sys; sys.path.insert(0, sys.argv[1] + "/scripts")',
    'from pathlib import Path',
    'import validate_pack as v',
    'v.ROOT = Path(sys.argv[2])',
    'docs = sorted(p for p in v.ROOT.rglob("*.md") if ".git" not in p.parts)',
    'broken, ignored = v.markdown_link_problems(docs)',
    'print(json.dumps({"broken": broken, "ignored": ignored, "warnings": v.WARNINGS}))',
  ].join('\n'), repo, root], { encoding: 'utf8' });
  return JSON.parse(out) as { broken: string[]; ignored: string[]; warnings: string[] };
}

describe('validate_pack.py Markdown links into git-ignored paths', () => {
  it('refuses a committed link into an ignored path even where the local copy exists, and still finds missing targets', () => {
    put('.gitignore', 'output/*\n!output/kept/\n');
    put('output/audits/REPORT.md', 'local evidence\n');
    put('output/kept/TRACKED.md', 'committed evidence\n');
    put('docs/a.md', '[report](../output/audits/REPORT.md) [kept](../output/kept/TRACKED.md) [gone](../missing.md) [web](https://example.com)\n');
    put('output/audits/LOCAL.md', '[sibling](REPORT.md)\n');
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'add', '.gitignore', 'docs', 'output/kept']);

    const result = problems(dir);
    expect(result.ignored).toEqual(['docs/a.md->../output/audits/REPORT.md']);
    expect(result.broken).toEqual(['docs/a.md->../missing.md']);
    expect(result.warnings).toEqual([]);
  });

  it('says so, rather than passing silently, where there is no git checkout to ask', () => {
    const bare = fs.mkdtempSync(path.join(dir, 'bundle-'));
    fs.mkdirSync(path.join(bare, 'docs'));
    fs.writeFileSync(path.join(bare, 'docs/a.md'), '[self](a.md)\n');
    const result = spawnSync('git', ['-C', bare, 'rev-parse'], { encoding: 'utf8' });
    if (result.status === 0) return; // tmpdir sits inside some checkout on this machine: nothing to show
    expect(problems(bare)).toEqual({ broken: [], ignored: [], warnings: ['git is unavailable: Markdown links into git-ignored paths were not checked'] });
  });
});
