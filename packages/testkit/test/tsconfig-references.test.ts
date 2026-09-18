import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// `tsc -b` orders its builds by tsconfig `references`, never by package.json. A workspace dependency
// without a reference builds only when something else happens to build it first: an old dist in the
// checkout, or the root tsconfig listing it earlier. On a clean tree creative failed with TS2307 on
// @hawa/integrations, and apps/worker and apps/core failed when built on their own.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Project {
  dir: string;
  name: string;
  dependencies: string[];
  /** Absolute project directories this tsconfig references; undefined when there is no tsconfig. */
  references: string[] | undefined;
}

function workspaceDirs(): string[] {
  const yaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^packages:\n((?:[ \t]+-.*\n?)+)/m.exec(yaml);
  if (!block) throw new Error('pnpm-workspace.yaml has no packages list');
  const globs = [...block[1].matchAll(/-\s*['"]?([^'"\s]+)['"]?/g)].map((m) => m[1]);
  return globs.flatMap((glob) => {
    const parent = glob.slice(0, -2);
    if (!glob.endsWith('/*') || parent.includes('*') || parent.startsWith('!')) {
      throw new Error(`pnpm-workspace.yaml glob ${glob} is not of the form dir/*; teach this test to expand it`);
    }
    return readdirSync(path.join(REPO_ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(REPO_ROOT, parent, entry.name, 'package.json')))
      .map((entry) => `${parent}/${entry.name}`);
  });
}

function tsconfigReferences(dir: string): string[] | undefined {
  const file = path.join(REPO_ROOT, dir, 'tsconfig.json');
  if (!existsSync(file)) return undefined;
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error) throw new Error(`${dir}/tsconfig.json: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  return ((config.references ?? []) as Array<{ path: string }>).map((reference) => {
    const target = path.resolve(REPO_ROOT, dir, reference.path);
    return target.endsWith('.json') ? path.dirname(target) : target;
  });
}

const PROJECTS: Project[] = workspaceDirs().map((dir) => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8'));
  return {
    dir,
    name: pkg.name,
    dependencies: Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }),
    references: tsconfigReferences(dir),
  };
});

describe('tsconfig project references', () => {
  it('reference every workspace package a project depends on', () => {
    const byName = new Map(PROJECTS.map((project) => [project.name, project]));
    const missing: string[] = [];
    let checked = 0;
    for (const project of PROJECTS) {
      if (!project.references) continue;
      for (const name of project.dependencies) {
        const dependency = byName.get(name);
        if (!dependency?.references) continue; // not a workspace package, or nothing to reference
        checked++;
        if (!project.references.includes(path.join(REPO_ROOT, dependency.dir))) {
          missing.push(
            `${project.dir}/tsconfig.json: add { "path": "${path.relative(project.dir, dependency.dir)}" } (package.json depends on ${name})`,
          );
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('include every workspace project in the root build', () => {
    const root = tsconfigReferences('.') ?? [];
    const missing = PROJECTS.filter((project) => project.references && !root.includes(path.join(REPO_ROOT, project.dir))).map(
      (project) => `tsconfig.json: add { "path": "${project.dir}" }`,
    );
    expect(PROJECTS.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
