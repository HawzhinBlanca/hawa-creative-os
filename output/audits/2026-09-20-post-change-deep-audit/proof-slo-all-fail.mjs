// Run the real measurement function with only app/database transport replaced in-memory.
// Every app request returns HTTP503. Original source/evidence files are never edited.
import fs from 'node:fs';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.cwd();
const sourcePath = path.join(root, 'scripts/measure_operations_slo.ts');
let source = fs.readFileSync(sourcePath, 'utf8');
function replaceRequired(from, to) {
  if (!source.includes(from)) throw new Error(`Expected injection boundary missing: ${from}`);
  source = source.replace(from, to);
}
replaceRequired("import { createApp } from '../apps/core/src/app.js';", 'const createApp = globalThis.__auditCreateApp;');
replaceRequired("import { createDb } from '../packages/db/src/index.js';", 'const createDb = globalThis.__auditCreateDb;');
for (const relative of ['../packages/integrations/src/cost-governor.js', '../packages/integrations/src/circuit-breaker.js']) {
  replaceRequired(relative, pathToFileURL(path.resolve(root, 'scripts', relative.replace(/\.js$/, '.ts'))).href);
}
source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href));
globalThis.fetch = async () => { throw new Error('Audit forbids network'); };
process.env.TEST_DATABASE_URL = 'postgres://audit.invalid/no_connection';
let attempted = 0;
globalThis.__auditCreateApp = () => ({ request: async () => {
  attempted++;
  return new Response(JSON.stringify({ id: 'synthetic', active: false, criticalPass: false, decision: 'denied' }), { status: 503 });
} });
globalThis.__auditCreateDb = () => ({ destroy: async () => {} });
const print = console.log.bind(console);
console.log = () => {};
fs.mkdirSync = () => undefined;
fs.writeFileSync = (file) => {
  if (!String(file).endsWith('/OPERATIONS_SLO_EVIDENCE.json')) throw new Error('Unexpected write refused');
};
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const evidence = await module.measureOperationsSLO();
print(JSON.stringify({
  scope: 'Actual measurement function; app503/database stub; evidence write intercepted',
  source: '6d3c583791a404c914e25b77dda558b16d26bd6c', attempted,
  status: evidence.status, observedAvailability: evidence.observedAvailability,
  latencySLOs: evidence.latencySLOs, faultTolerance: evidence.faultTolerance,
  traceStatuses: evidence.endToEndTaskTrace.stages.map(s => s.status),
}, null, 2));
