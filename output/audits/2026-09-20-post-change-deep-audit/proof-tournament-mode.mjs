// Actual tournament script and dependencies; no original artifact write, no network.
// Run twice: node --import tsx <file> [--live].
import fs from 'node:fs';
const print = console.log.bind(console);
console.log = console.warn = console.error = () => {};
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Audit forbids network'); };
fs.mkdirSync = () => undefined;
fs.writeFileSync = (file, bytes) => {
  if (!String(file).endsWith('/MODEL_TOURNAMENT_EVIDENCE.json')) throw new Error('Unexpected write refused');
  const e = JSON.parse(bytes);
  print(JSON.stringify({
    scope: 'Actual script; only evidence write intercepted',
    source: '6d3c583791a404c914e25b77dda558b16d26bd6c',
    liveFlag: process.argv.includes('--live'), networkAttempts,
    proofClass: e.proofClass, simulated: e.simulated,
    routing: e.routingBriefTournament, admissions: e.admissions,
    overallVerdict: e.overallVerdict,
  }, null, 2));
};
await import('../../../scripts/run_model_tournament.ts');
