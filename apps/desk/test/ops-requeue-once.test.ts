import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/**
 * Hunt-3: Ops' "Re-Queue Task" was never disabled and sent no key, so a double click re-drove the
 * task twice (each re-drive pays for a design). Lifted from OpsScreen.tsx (no copy of the logic).
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/screens/OpsScreen.tsx'), 'utf8');
const FILE = ts.createSourceFile('OpsScreen.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function lift<T>(name: string, closure: Record<string, unknown>): T {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) { found = node.initializer; return; }
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  if (!found) throw new Error(`OpsScreen.tsx has no const ${name}`);
  const js = ts.transpileModule(`const __lifted = ${found.getText(FILE)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  const keys = Object.keys(closure);
  return new Function(...keys, `${js}\nreturn __lifted;`)(...keys.map((k) => closure[k])) as T;
}

describe('re-queueing a failed task from Ops (hunt-3)', () => {
  it('a second press while the first is in flight sends nothing', async () => {
    let answer: (() => void) | undefined;
    const redrive = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const requeueStarted = { current: false };
    const requeue = lift<() => Promise<void>>('requeueInspected', {
      apiClient: { tasks: { redrive } }, inspectingFailure: { id: 'task-12345678' }, requeueStarted,
      setRequeueing: vi.fn(), setOpsToast: vi.fn(), setInspectingFailure: vi.fn(), setTimeout: () => 0,
    });
    const first = requeue();
    await requeue();
    expect(redrive).toHaveBeenCalledTimes(1);
    answer!();
    await first;
    expect(requeueStarted.current).toBe(false);
  });
  it('the button is disabled while it runs', () => {
    expect(SOURCE).toMatch(/onClick=\{\(\) => void requeueInspected\(\)\}\s*disabled=\{requeueing\}/);
  });
});
