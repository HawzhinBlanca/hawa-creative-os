import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/**
 * Hunt-3: the Canva panel's `run` (CanvaTaskPanel.tsx) read the task again inside the same try as the
 * action. When the action succeeded (an export submitted, a design linked) and only that read failed,
 * the success message was replaced by the read's error, and the office thought the action had failed
 * and pressed it again. Lifted from the component with the TypeScript parser (no copy of the logic).
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/components/CanvaTaskPanel.tsx'), 'utf8');
const FILE = ts.createSourceFile('CanvaTaskPanel.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function lift<T>(name: string, closure: Record<string, unknown>): T {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) { found = node.initializer; return; }
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  if (!found) throw new Error(`CanvaTaskPanel.tsx has no const ${name}`);
  const js = ts.transpileModule(`const __lifted = ${found.getText(FILE)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  const keys = Object.keys(closure);
  return new Function(...keys, `${js}\nreturn __lifted;`)(...keys.map((k) => closure[k])) as T;
}

/** setMessage as React gives it: a value or an updater of the current message. */
function messages() {
  let current = '';
  const setMessage = (m: string | ((prev: string) => string)) => { current = typeof m === 'function' ? m(current) : m; };
  return { setMessage, last: () => current };
}
const runWith = (setMessage: unknown, refresh: () => Promise<void>) =>
  lift<(fn: () => Promise<void>) => Promise<void>>('run', { setBusy: vi.fn(), setMessage, refresh });

describe('a Canva panel action whose follow-up read failed (hunt-3)', () => {
  it('keeps the action\'s own message and says only that the panel could not be refreshed', async () => {
    const m = messages();
    await runWith(m.setMessage, () => Promise.reject(new Error('Service Unavailable')))(async () => {
      m.setMessage('Export submitted to Canva. Check its progress below.');
    });
    expect(m.last()).toContain('Export submitted to Canva');
    expect(m.last()).toMatch(/could not be refreshed/i);
  });
  it('still reports a failed action as failed', async () => {
    const m = messages();
    await runWith(m.setMessage, () => Promise.resolve())(async () => { throw new Error('Canva refused the export'); });
    expect(m.last()).toBe('Canva refused the export');
  });
});
