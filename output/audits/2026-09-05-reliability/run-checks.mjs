// Audit evidence only. Does not implement or repair application functionality.
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));
process.chdir(root);
mkdirSync(out + 'logs', {recursive:true});
const sourcePaths = spawnSync('git',['ls-files'],{encoding:'utf8'}).stdout.trim().split('\n').filter(p=> /^(apps|packages|scripts|infra|deployment|db|plans)\//.test(p) || /^(package.json|pnpm-lock.yaml|AGENTS.md|MASTER_SPEC.md|AI_BUILD_PROMPT.md)$/.test(p));
function snapshot() {return Object.fromEntries(sourcePaths.map(p=>{try{return [p,createHash('sha256').update(readFileSync(p)).digest('hex')]}catch{return [p,'UNAVAILABLE']}}));}
const before=snapshot();
writeFileSync(out+'source-before.json',JSON.stringify({at:new Date().toISOString(),head:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),dirty:spawnSync('git',['status','--short'],{encoding:'utf8'}).stdout,node:process.version,files:before},null,2));
const checks=[['unit','pnpm',['test']],['typecheck','pnpm',['typecheck']],['lint','pnpm',['lint']],['desk-build','pnpm',['--filter','@hawa/desk','build']],['pack','python3',['scripts/validate_pack.py']],['db-static','pnpm',['db:check']],['security-patterns','python3',['infra/security/security_scan.py']],['adversarial','pnpm',['exec','tsx',out+'probes.ts']]];
const env={...process.env};
// Never call paid services or a configured live database in this audit.
for(const key of ['DATABASE_URL','GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','PHOENIX_API_KEY','PHOENIX_COLLECTOR_ENDPOINT','OTEL_EXPORTER_OTLP_ENDPOINT']) delete env[key];
const results=[];
for(const [id,cmd,args] of checks){
 const t=Date.now(); const r=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 const text=(r.stdout||'')+'\n'+(r.stderr||'');
 writeFileSync(out+'logs/'+id+'.log',text);
 const result={id,command:[cmd,...args].join(' '),exitCode:r.status,signal:r.signal,error:r.error?.message,durationMs:Date.now()-t,log:'logs/'+id+'.log'};results.push(result);console.log(JSON.stringify(result));
}
const after=snapshot();
writeFileSync(out+'checks.json',JSON.stringify({at:new Date().toISOString(),scope:'Diagnostic checks; green results are NOT a production admission',results,sourceDrift:Object.keys(before).filter(p=>before[p]!==after[p])},null,2));
writeFileSync(out+'source-after.json',JSON.stringify(after,null,2));
