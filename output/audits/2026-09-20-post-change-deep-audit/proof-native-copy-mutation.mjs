// Executes the actual W06 test assertions sequentially with a small assert facade,
// preserving real encoder/QA code. Optional --corrupt-copy mutates only encoder input.
// All proof-file writes are intercepted. No Vitest global setup, DB or network.
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { encodeEditableTransfer } from '../../../packages/creative/src/editable-transfer.ts';
const root = process.cwd();
const sourcePath = path.join(root, 'packages/creative/test/native-script-fidelity.test.ts');
const packageRequire = createRequire(sourcePath);
const { unzipSync, strFromU8 } = packageRequire('fflate');
let source = fs.readFileSync(sourcePath, 'utf8');
const corrupt = process.argv.includes('--corrupt-copy');
const appendCopy = process.argv.includes('--append-copy');
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
globalThis.fetch = async () => { throw new Error('Audit forbids network'); };
const registered = [];
let mutationCount = 0, confirmedCorruptExports = 0, evidence;
globalThis.__auditDescribe = (_, fn) => fn();
globalThis.__auditIt = (name, fn) => registered.push({ name, fn });
globalThis.__auditExpect = value => ({
  toBe: expected => assert.equal(value, expected),
  toContain: expected => assert.ok(value.includes(expected), `Missing ${expected}`),
  toBeDefined: () => assert.notEqual(value, undefined),
  rejects: { toThrow: async expected => assert.rejects(value, expected) },
});
globalThis.__auditNativeWrite = (file, bytes) => {
  if (!String(file).endsWith('/W06_NATIVE_SCRIPT_FIDELITY_EVIDENCE.json')) throw new Error('Unexpected write refused');
  evidence = JSON.parse(bytes);
};
globalThis.__auditEncode = async (plan, copy, ...rest) => {
  const changedCopy = corrupt ? copy.map(() => 'AUDIT CORRUPTED FACTUAL COPY 999999') : appendCopy ? copy.map(text => `${text} AUDIT UNAPPROVED EXTRA CLAIM 999999`) : copy;
  const result = await encodeEditableTransfer(plan, changedCopy, ...rest);
  if (corrupt || appendCopy) {
    mutationCount++;
    const xml = strFromU8(unzipSync(new Uint8Array(result.bytes))['ppt/slides/slide1.xml']);
    if (xml.includes(corrupt ? 'AUDIT CORRUPTED FACTUAL COPY 999999' : 'AUDIT UNAPPROVED EXTRA CLAIM 999999')) confirmedCorruptExports++;
  }
  return result;
};
function replaceRequired(from, to) {
  if (!source.includes(from)) throw new Error(`Expected injection boundary missing: ${from}`);
  source = source.replace(from, to);
}
replaceRequired("import { describe, it, expect } from 'vitest';", 'const describe = globalThis.__auditDescribe; const it = globalThis.__auditIt; const expect = globalThis.__auditExpect;');
replaceRequired("import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';", "import { readFileSync } from 'node:fs'; const writeFileSync = globalThis.__auditNativeWrite; const mkdirSync = () => {};");
replaceRequired("import { encodeEditableTransfer, type EditableTransferPlan } from '../src/editable-transfer.js';", 'const encodeEditableTransfer = globalThis.__auditEncode;');
replaceRequired("'fflate'", JSON.stringify(pathToFileURL(packageRequire.resolve('fflate')).href));
replaceRequired("'../../qa/src/rtl-validator.js'", JSON.stringify(pathToFileURL(path.join(root, 'packages/qa/src/rtl-validator.ts')).href));
source = source.replaceAll('__dirname', JSON.stringify(path.dirname(sourcePath)));
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const results = [];
for (const test of registered) {
  try { await test.fn(); results.push({ name: test.name, status: 'PASS' }); }
  catch (err) { results.push({ name: test.name, status: 'FAIL', reason: err.message }); }
}
console.log(JSON.stringify({
  scope: 'Actual W06 assertion bodies with real encoder and QA; lightweight assert facade; output write intercepted',
  source: '6d3c583791a404c914e25b77dda558b16d26bd6c', sourceSha256, corrupt, appendCopy, mutationCount, confirmedCorruptExports,
  results, evidence: evidence ? {
    syntheticCount: evidence.synthetic40Cases.total, syntheticPassed: evidence.synthetic40Cases.passed,
    realCount: evidence.realCommercial20Cases.total, realPassed: evidence.realCommercial20Cases.passed,
    componentFidelityVerdict: evidence.componentFidelityVerdict, liveCanvaHumanInspection: evidence.liveCanvaHumanInspection,
  } : null,
}, null, 2));
