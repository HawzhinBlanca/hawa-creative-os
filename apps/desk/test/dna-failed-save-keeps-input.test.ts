import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/**
 * Hunt-3: a DNA edit Core refused keeps what the person typed. The handlers live inside DnaScreen;
 * as in work-screen-truth.test.ts they are lifted out with the TypeScript parser and run with
 * stand-ins for the setters they close over. Nothing here is a copy of the logic.
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/screens/DnaScreen.tsx'), 'utf8');
const FILE = ts.createSourceFile('DnaScreen.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function lift<T>(name: string, closure: Record<string, unknown>): T {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) { found = node.initializer; return; }
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  if (!found) throw new Error(`DnaScreen.tsx has no const ${name}`);
  const js = ts.transpileModule(`const __lifted = ${found.getText(FILE)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  const keys = Object.keys(closure);
  return new Function(...keys, `${js}\nreturn __lifted;`)(...keys.map((k) => closure[k])) as T;
}

const dna = { clientId: 'c1', version: 3, colors: [], guidelines: { prohibitedPhrases: [], requiredDisclaimers: [], layoutRules: [] } };

describe('a DNA save Core refused (hunt-3)', () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['handleAddSwatch', { newSwatchName: 'Navy', newSwatchHex: '#000080', newSwatchRole: 'primary' }, ['setNewSwatchName', 'setShowAddSwatch']],
    ['handleApplyExtractedPalette', { extractedPaletteData: { primary: '#111111', secondary: '#222222', accent: '#333333', cardBg: '#ffffff' } }, ['setShowLogoDropzone', 'setExtractedPaletteData']],
    ['handleAddProhibitedPhrase', { newPhrase: 'guaranteed' }, ['setNewPhrase']],
    ['handleAddDisclaimer', { newDisclaimer: 'Terms apply.' }, ['setNewDisclaimer']],
    ['handleAddLayoutRule', { newRule: 'Logo top right' }, ['setNewRule']],
  ];
  it.each(cases)('%s leaves the typed input in place', async (name, state, clears) => {
    const setters = Object.fromEntries(clears.map((s) => [s, vi.fn()]));
    const saveDnaChanges = vi.fn().mockResolvedValue(false);
    const handler = lift<() => Promise<void>>(name, { currentDna: dna, saveDnaChanges, ...state, ...setters });
    await handler();
    expect(saveDnaChanges).toHaveBeenCalledTimes(1);
    for (const s of clears) expect(setters[s], s).not.toHaveBeenCalled();
  });
  it.each(cases)('%s clears it once Core saved', async (name, state, clears) => {
    const setters = Object.fromEntries(clears.map((s) => [s, vi.fn()]));
    const handler = lift<() => Promise<void>>(name, { currentDna: dna, saveDnaChanges: vi.fn().mockResolvedValue(true), ...state, ...setters });
    await handler();
    for (const s of clears) expect(setters[s], s).toHaveBeenCalled();
  });
});
