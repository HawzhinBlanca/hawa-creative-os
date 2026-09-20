// Real default tournament, no provider calls; intercept its evidence write, not its checks.
import fs from 'node:fs';
globalThis.fetch = async () => { throw new Error('Network forbidden in audit'); };
const write=fs.writeFileSync, mkdir=fs.mkdirSync;
fs.mkdirSync=()=>undefined;
fs.writeFileSync=(file,bytes)=>{
  if(!String(file).endsWith('/MODEL_TOURNAMENT_EVIDENCE.json')) throw new Error('Unexpected write blocked');
  const e=JSON.parse(bytes);
  console.log(JSON.stringify({proofClass:'Unmodified default evaluator, fake/offline dependencies; output write intercepted',overallVerdict:e.overallVerdict,admissions:e.admissions,routing:e.routingBriefTournament,studio:e.designStudioTournament},null,2));
  fs.writeFileSync=write; fs.mkdirSync=mkdir;
};
await import('../../../scripts/run_model_tournament.ts');
