#!/usr/bin/env tsx
/**
 * Hawa Creative OS — Test Suite Typecheck Validator
 *
 * Verifies that all active test suites across packages and apps typecheck cleanly
 * without compiler errors.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const compilerPath = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
export const TEST_TYPE_PROJECTS = ['tsconfig.test.json', 'apps/desk/tsconfig.test.json'] as const;

export function testTypeCoverage(root = rootDir, projects: readonly string[] = TEST_TYPE_PROJECTS) {
  const expected = ts.sys.readDirectory(root, ['.ts', '.tsx'],
    ['archive/**', '**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.turbo/**', '**/.claude/**'],
    ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx']);
  const covered = new Set<string>();
  const errors: string[] = [];
  for (const project of projects) {
    const file = path.resolve(root, project), read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) { errors.push(ts.flattenDiagnosticMessageText(read.error.messageText, '\n')); continue; }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file));
    errors.push(...parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')));
    for (const name of parsed.fileNames) covered.add(path.resolve(name));
  }
  if (!expected.length) errors.push('No active test files discovered; refusing an empty gate.');
  const missing = expected.filter(file => !covered.has(path.resolve(file))).map(file => path.relative(root, file));
  return { expected: expected.length, covered: expected.length - missing.length, missing, errors };
}

/** Paths are injectable for real negative controls; the gate uses the installed pinned compiler. */
export function compileTestProject(project: string, options: { cwd?: string; compiler?: string; executable?: string } = {}): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(options.executable ?? process.execPath,
      [options.compiler ?? compilerPath, '-p', project, '--pretty', 'false'],
      { cwd: options.cwd ?? rootDir, stdio: 'inherit', shell: false });
    child.once('error', error => { console.error(`[Typecheck:tests] Compiler could not start: ${error.message}`); resolve(false); });
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) console.error(`[Typecheck:tests] Compiler failed for ${project} (exit=${code}, signal=${signal ?? 'none'}).`);
      resolve(code === 0 && signal === null);
    });
  });
}

export async function runTypecheckTests(): Promise<boolean> {
  const coverage = testTypeCoverage();
  if (coverage.errors.length || coverage.missing.length) {
    console.error('[Typecheck:tests] Test coverage/configuration failed:', ...coverage.errors, ...coverage.missing);
    return false;
  }
  console.log(`[Typecheck:tests] Compiling ${coverage.covered}/${coverage.expected} active test roots and their dependencies.`);
  let passed = true;
  for (const project of TEST_TYPE_PROJECTS) {
    if (!await compileTestProject(project)) passed = false;
  }
  console.log(passed ? '[Typecheck:tests] All test projects passed.' : '[Typecheck:tests] FAILED. Preserve and repair every compiler error above.');
  return passed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runTypecheckTests().then(ok => { process.exitCode = ok ? 0 : 1; }).catch(error => {
    console.error('[Typecheck:tests] Failed:', error);
    process.exitCode = 1;
  });
}
