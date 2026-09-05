import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('.',import.meta.url));const root=fileURLToPath(new URL('../../..',import.meta.url));
mkdirSync(out+'final-logs',{recursive:true});
const env={...process.env};for(const k of ['DATABASE_URL','GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'])delete env[k];
const checks=[['unit','pnpm',['test']],['typecheck','pnpm',['typecheck']],['desk-build','pnpm',['--filter','@hawa/desk','build']],['pack','python3',['scripts/validate_pack.py']],['dependency-audit','pnpm',['audit','--prod','--json']]];
const results=[];
for(const [id,cmd,args]of checks){const r=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});writeFileSync(out+'final-logs/'+id+'.log',(r.stdout||'')+'\n'+(r.stderr||''));const a={id,exitCode:r.status,error:r.error?.message,signal:r.signal,log:'final-logs/'+id+'.log'};results.push(a);console.log(a);}
const paths=spawnSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).stdout.trim().split('\n').filter(p=>!p.startsWith('output/')&&!p.endsWith('.tsbuildinfo'));
const files=Object.fromEntries(paths.map(p=>{try{return[p,createHash('sha256').update(readFileSync(root+'/'+p)).digest('hex')]}catch{return[p,'UNAVAILABLE']}}));
const before=JSON.parse(readFileSync(out+'source-before.json','utf8')).files;
writeFileSync(out+'final-checks.json',JSON.stringify({at:new Date().toISOString(),results,changedSinceFirstCheck:Object.keys(before).filter(p=>files[p]&&before[p]!==files[p]),head:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),dirty:spawnSync('git',['status','--short'],{cwd:root,encoding:'utf8'}).stdout},null,2));
writeFileSync(out+'source-final.json',JSON.stringify({at:new Date().toISOString(),files},null,2));
