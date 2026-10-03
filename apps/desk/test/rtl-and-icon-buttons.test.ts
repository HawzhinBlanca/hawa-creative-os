import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Hunt-3: text a requester or the office may write in Sorani is shown and typed with dir="auto", and
 * every icon-only button has a name a screen reader can say. Read from the shipped TSX with the parser.
 */
const read = (rel: string) => {
  const text = fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8');
  return { text, file: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) };
};

/** Every JSX element (opening or self-closing) whose source satisfies `match`. */
function elements(rel: string, match: (src: string) => boolean): string[] {
  const { file } = read(rel);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && match(node.getText(file))) out.push(node.openingElement.getText(file));
    else if (ts.isJsxSelfClosingElement(node) && match(node.getText(file))) out.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
const innermost = (found: string[]) => found.at(-1) ?? '';

describe('Sorani text direction (hunt-3)', () => {
  const cases: Array<[string, (src: string) => boolean]> = [
    ['screens/WorkScreen.tsx', (s) => /^<div className="copy-value-en"[^>]*>\{selectedTask\.description\}<\/div>$/.test(s)],
    ['screens/WorkScreen.tsx', (s) => s.startsWith('<textarea') && s.includes('id="revision-comment"')],
    ['screens/WorkScreen.tsx', (s) => s.startsWith('<textarea') && s.includes('value={rejectionReason}')],
    ['App.tsx', (s) => s.startsWith('<input') && s.includes('id="modal-task-title"')],
    ['screens/DnaScreen.tsx', (s) => /^<span>\{phrase\}<\/span>$/.test(s) || /^<span dir="auto">\{phrase\}<\/span>$/.test(s)],
  ];
  it.each(cases)('%s: %#', (rel, match) => {
    const found = elements(rel, match);
    expect(found.length, 'element not found').toBeGreaterThan(0);
    for (const el of found) expect(el).toMatch(/dir="auto"/);
  });
  it('CommandPalette result titles', () => {
    const found = elements('components/CommandPalette.tsx', (s) => s.startsWith('<span') && /\{item\.title\}\s*<\/span>$/.test(s));
    expect(found.length).toBeGreaterThan(0);
    for (const el of found) expect(el).toMatch(/dir="auto"/);
  });
});

describe('icon-only buttons have a name (hunt-3)', () => {
  const files = ['screens/DnaScreen.tsx', 'screens/SettingsScreen.tsx', 'components/GuidedTour.tsx'];
  it.each(files)('%s', (rel) => {
    const found = elements(rel, (s) => s.startsWith('<button') && /^<button[\s\S]*>\s*[✕×]\s*<\/button>$/.test(s));
    expect(found.length).toBeGreaterThan(0);
    for (const el of found) expect(el).toMatch(/aria-label=/);
  });
});

describe('the Work screen never makes up a request (hunt-3)', () => {
  it('has no fallback that creates a task with invented words', () => {
    const { text } = read('screens/WorkScreen.tsx');
    expect(text).not.toMatch(/Intake campaign instructions|Campaign Brief \$\{/);
    expect(text).not.toMatch(/apiClient\.tasks\.create\(/);
  });
});
