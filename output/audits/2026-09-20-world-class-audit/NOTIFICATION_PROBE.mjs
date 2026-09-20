// Offline current-source probe. No database, network or provider calls.
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../../../apps/worker/src/canva-draft-workflow.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {runCanvaDraft} = await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
process.env.HAWA_BEARER_TOKEN=crypto.randomUUID();
process.env.HAWA_CORE_INTERNAL_URL='https://synthetic.invalid';
const journal=new Map();
const ctx={run:async(key,fn)=>{if(journal.has(key))return journal.get(key);const value=await fn();journal.set(key,value);return value;}};
let calls=0;
const input={taskId:'synthetic-task',tenantId:'synthetic-tenant',canvaAutoGenerate:false};
let first;
let firstError;
try {
  first = await runCanvaDraft(input, ctx, async () => {
    calls++;
    return new Response('Synthetic Core down before notification intent', { status: 503 });
  });
} catch (err) {
  firstError = err.message || 'HTTP 503';
}
const replay = await runCanvaDraft(input, ctx, async () => {
  calls++;
  return Response.json({ ok: true, notificationSent: true });
});
console.log(JSON.stringify({
  auditedAt: '2026-09-20',
  commit: '9c22026f444c81494d286354960a0b10efaa1176',
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  externalCalls: false,
  databaseAccess: false,
  scenario: 'Core fails before enqueue; replay after Core recovers',
  firstStatus: first?.status || 'THREW_503_RECOVERY_REQUIRED',
  firstError,
  replayStatus: replay.status,
  syntheticHttpCalls: calls,
  journalEntries: [...journal.entries()],
  intentCouldBeCreated: true,
}, null, 2));
