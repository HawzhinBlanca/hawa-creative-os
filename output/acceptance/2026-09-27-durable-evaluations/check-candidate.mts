import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const root=new URL('../../../',import.meta.url);
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const rehearsal=JSON.parse(readFileSync(new URL('packages/testkit/chaos/.run/last-run.json',root),'utf8'));
if(rehearsal.deployment.commit!==source || Object.keys(rehearsal.deployment.sourceChanges).length || rehearsal.scenarios[0].invariants.some((v:any)=>!v.ok))throw new Error('Candidate workflow proof must match current source');
if(!rehearsal.deployment.containers.core.networks.every((n:string)=>['hawa-chaos_chaos','hawa-chaos_parser'].includes(n)) || !rehearsal.deployment.networks.includes('hawa-chaos_chaos|true'))throw new Error('Candidate model transport must be isolated');
const env=Object.fromEntries(readFileSync(new URL('packages/testkit/chaos/.run/chaos.env',root),'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
const origin='http://127.0.0.1:56081';
async function request(path:string,body?:unknown,action?:string){
 const response=await fetch(`${origin}/v1${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${env.CHAOS_BEARER_TOKEN}`,'Content-Type':'application/json',...(action?{'Idempotency-Key':action}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 return {status:response.status,body:await response.json()};
}
const checks:Array<{name:string;ok:boolean}>=[];
function check(name:string,ok:boolean){checks.push({name,ok});if(!ok)throw new Error(name);}
const ledger=async()=>await(await fetch('http://127.0.0.1:56090/__fakes/models/ledger')).json() as {ledger:unknown[]};
const before=await ledger();
check('Missing action is refused before transport',(await request('/evaluations/runs',{name:'Missing action'})).status===400);
const action=randomUUID(),body={name:'[TEST] durable evaluation candidate hold'};
const first=await request('/evaluations/runs',body,action);
check('Candidate evaluation returns a saved stopped report',first.status===200&&first.body.status==='failed'&&first.body.report.executionStatus==='stopped'&&first.body.report.overallPassRate===null);
check('Fixture report is not model admission',first.body.report.admissionEligible===false);
const detail=await request(`/evaluations/runs/${first.body.runId}`);
check('One uncertain call is visible with unknown cost',detail.status===200&&detail.body.calls.length===1&&detail.body.calls[0].status==='uncertain'&&detail.body.calls[0].estimatedCostUsd===null);
check('Provider fact comes from the observed failure',detail.body.calls[0].provider==='google');
check('Read endpoint omits saved model output',!('outcome' in detail.body.calls[0]));
const restarted=spawnSync('docker',['restart','hawa-chaos-core-1'],{encoding:'utf8',timeout:30000});
if(restarted.status!==0)throw new Error('Candidate Core restart failed');
let ready=false;
for(let i=0;i<100;i++){try{if((await request('/evaluations/runs')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
check('Fresh candidate Core reads saved history',ready);
const repeated=await request('/evaluations/runs',body,action);
check('Repeated action returns the identical saved report after restart',repeated.status===200&&JSON.stringify(repeated.body)===JSON.stringify(first.body));
check('A fresh action cannot bypass uncertainty',(await request('/evaluations/runs',{name:'[TEST] blocked bypass'},randomUUID())).status===409);
check('Changed input with the old action conflicts',(await request('/evaluations/runs',{name:'[TEST] changed input'},action)).status===409);
const after=await ledger();check('Exactly one fake provider request across restarts and retries',after.ledger.length-before.ledger.length===1);
const images=['core','desk','worker-blue'].map(service=>{
 const result=spawnSync('docker',['inspect','--format','{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',`hawa-chaos-${service}-1`],{encoding:'utf8'});
 if(result.status!==0)throw new Error('Candidate image inspection failed');const [imageId,buildCommit]=result.stdout.trim().split('|');check(`${service} image source matches`,buildCommit===source);return {service,imageId,buildCommit};
});
writeFileSync(new URL('candidate-rehearsal.json',import.meta.url),JSON.stringify(rehearsal,null,2)+'\n');
const receipt={sourceCommit:source,checkedAt:new Date().toISOString(),workflowInvariants:rehearsal.scenarios[0].invariants.length,checks,images,
 callCount:1,providerScope:'Docker internal fake provider; no real provider call',coreRestarts:1,productionChanged:false};
writeFileSync(new URL('candidate-evaluation.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:source,workflowInvariants:receipt.workflowInvariants,checks:checks.length,allPassed:true,providerCalls:1,productionChanged:false}));
