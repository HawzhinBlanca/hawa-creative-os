import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommitErrors } from '../../../scripts/verify_release_manifest.js';

/**
 * What RELEASE_MANIFEST.json's build commit must be relative to HEAD (ported from studio-v2
 * c2bf4943). It required HEAD, HEAD~1 or HEAD~2: a merge commit puts the build commit on its
 * second parent, so every merged PR went red, while a code commit two back passed unnoticed. The
 * manifest certifies its build commit's tree: HEAD may be that commit or any descendant whose only
 * changes since are the three manifest files.
 */
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-manifest-commit-'));
  temps.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  const commit = (file: string, text: string, message: string) => {
    fs.writeFileSync(path.join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

describe('the release manifest build commit', () => {
  it('passes at the build commit and after commits that change only the manifest files', () => {
    const r = repo();
    const build = r.commit('app.ts', 'one', 'code');
    expect(buildCommitErrors(build, r.dir)).toEqual([]);
    r.commit('RELEASE_MANIFEST.json', '{}', 'record manifest');
    r.commit('MANIFEST.json', '{}', 'refresh');
    r.commit('SHA256SUMS.txt', 'x', 'refresh');
    expect(buildCommitErrors(build, r.dir)).toEqual([]);
  });

  it('passes on a merge commit that brings the build commit in on its second parent', () => {
    const r = repo();
    r.commit('base.ts', 'base', 'base');
    r.git('checkout', '-q', '-b', 'feature');
    const build = r.commit('app.ts', 'feature', 'feature code');
    r.commit('RELEASE_MANIFEST.json', '{}', 'record manifest');
    r.git('checkout', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    expect(buildCommitErrors(build, r.dir)).toEqual([]);
  });

  it('refuses a code change since the build commit, even two commits back', () => {
    const r = repo();
    const build = r.commit('app.ts', 'one', 'code');
    r.commit('app.ts', 'two', 'more code');
    r.commit('RELEASE_MANIFEST.json', '{}', 'record manifest');
    const errors = buildCommitErrors(build, r.dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/1 file\(s\) changed since the manifest build commit .*app\.ts/);
  });

  it('refuses a build commit that is not an ancestor of HEAD', () => {
    const r = repo();
    r.commit('base.ts', 'base', 'base');
    r.git('checkout', '-q', '-b', 'side');
    const side = r.commit('app.ts', 'side', 'side');
    r.git('checkout', '-q', 'main');
    r.commit('other.ts', 'main', 'main');
    expect(buildCommitErrors(side, r.dir)).toEqual([`Manifest build commit (${side}) is not an ancestor of HEAD`]);
  });
});
