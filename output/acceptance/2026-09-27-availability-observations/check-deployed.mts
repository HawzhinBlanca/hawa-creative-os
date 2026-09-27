// Isolated hawa-chaos only. Actual collector/Core/PostgreSQL process death and real Chrome.
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {query,secrets,sql,closeDb,FAKES_URL,kill,start,compose} from '/Users/hawzhin/Hawdesign/packages/testkit/chaos/driver/stack.ts';
import {TENANT_ID} from '/Users/hawzhin/Hawdesign/packages/testkit/chaos/driver/provision.ts';
import {chromium} from '/Users/hawzhin/Hawdesign/apps/desk/node_modules/@playwright/test/index.mjs';
import {parseOperationsReliabilityReport,availabilityOutcome} from '/Users/hawzhin/Hawdesign/packages/contracts/src/operations-reliability.ts';
const expected=process.argv[2];if(!/^[a-f0-9]{40}$/.test(expected||''))throw new Error('Supply exact candidate commit');
const root='/Users/hawzhin/Hawdesign',origin='http://127.0.0.1:56081',monitor='00000000-0000-4000-a000-000000000104';
const out=process.env.HAWA_AVAILABILITY_EVIDENCE_DIR||mkdtempSync('/private/tmp/hawa-availability-deployed-');mkdirSync(out,{recursive:true});
const spool=join(out,'private-observations.sqlite'),checks:Array<{name:string;passed:boolean}>=[],hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const identity={userId:randomUUID(),token:'hawa_sess_'+randomUUID().replaceAll('-','')};let completed=false;
const check=(name:string,passed:boolean)=>{checks.push({name,passed});console.log(JSON.stringify({name,passed}));if(!passed)throw new Error(name);};
const request=async(path:string,credential=identity.token,extra:Record<string,string>={})=>{
 const r=await fetch(origin+'/v1'+path,{headers:{Authorization:'Bearer '+credential,...extra},signal:AbortSignal.timeout(10000)});
 return {status:r.status,body:await r.json(),cache:r.headers.get('Cache-Control')};
};
const probe=()=>request('/monitoring/availability/probe',secrets().CHAOS_AVAILABILITY_SECRET,{'X-Hawa-Probe-Nonce':randomUUID()});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ready=async()=>{for(let i=0;i<24;i++){try{if((await probe()).status===200)return;}catch{}await sleep(1000);}throw new Error('Readiness did not recover');};
const nextMinute=async()=>{const ms=61000-Date.now()%60000;console.log('Waiting for the next real observation minute');await sleep(ms);};
const baseEnv=()=>({...process.env,HAWA_AVAILABILITY_MONITOR_ID:monitor,HAWA_AVAILABILITY_TARGET_ORIGIN:origin,HAWA_AVAILABILITY_MONITOR_SECRET:secrets().CHAOS_AVAILABILITY_SECRET});
const collector=(mode='--once')=>{
 const r=spawnSync('python3',['infra/monitoring/availability_collector.py','--spool',spool,mode],{cwd:root,env:baseEnv(),encoding:'utf8',timeout:50000});
 if(r.status!==0&&r.status!==1)throw new Error('Collector failed: '+r.status+' '+r.stderr);
 return JSON.parse(r.stdout.trim());
};
const inspectSpool=()=>{
 const code="import json,sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(json.dumps([dict(payload=json.loads(p),receipt=json.loads(r) if r else None) for p,r in d.execute('select payload,receipt from observations order by slot')]))";
 return JSON.parse(spawnSync('python3',['-c',code,spool],{encoding:'utf8',timeout:10000}).stdout);
};
const modelCount=async()=>((await(await fetch(FAKES_URL+'/__fakes/models/ledger')).json()) as {ledger:unknown[]}).ledger.length;
const officeCounts=async()=>(await query(sql`SELECT (SELECT count(*)::integer FROM hawa.tasks) AS tasks,(SELECT count(*)::integer FROM hawa.approvals) AS approvals,
 (SELECT count(*)::integer FROM hawa.requests) AS requests,(SELECT count(*)::integer FROM hawa.outbox_commands) AS outbox`))[0];
try{
 await ready();check('exact candidate is deployed',(await request('/health',secrets().CHAOS_BEARER_TOKEN)).body.buildCommit===expected);
 const beforeModels=await modelCount(),beforeOffice=await officeCounts();
 await query(sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${identity.userId}::uuid,${identity.userId+'@example.test'},'Synthetic availability reader',${identity.userId})`);
 await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${TENANT_ID}::uuid,${identity.userId}::uuid,'designer')`);
 await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
 VALUES(${hash(identity.token)},${TENANT_ID}::uuid,${identity.userId}::uuid,${'oidc:'+identity.userId},'designer','Synthetic availability reader',now()+interval '1 hour','google_oidc')`);
 const first=await request('/operations/slo');check('deployed named read accepts v2 evidence with unknown monthly compliance',first.status===200&&parseOperationsReliabilityReport(first.body)!==null&&first.body.availability.sloCompliant===null&&first.cache==='no-store');
 const killCode="import os,sys,signal;sys.path.insert(0,'infra/monitoring');from availability_collector import Spool,Transport,collect;\nclass Lost(Transport):\n def request(self,path,**kw):\n  r=super().request(path,**kw)\n  if path.endswith('/observations') and r[0] in (200,201): os.kill(os.getpid(),signal.SIGKILL)\n  return r\ns=Spool(sys.argv[1],os.environ['HAWA_AVAILABILITY_MONITOR_ID'],os.environ['HAWA_AVAILABILITY_TARGET_ORIGIN']);t=Lost(s.origin,os.environ['HAWA_AVAILABILITY_MONITOR_SECRET']);collect(s,t);s.flush(t)";
 const killed=spawnSync('python3',['-c',killCode,spool],{cwd:root,env:baseEnv(),encoding:'utf8',timeout:50000});
 check('actual collector dies after Core commits upload but before local acknowledgement',killed.signal==='SIGKILL'&&inspectSpool()[0].receipt===null);
 const original=inspectSpool()[0].payload;check('first real collector sample observed Desk assets and office readiness',availabilityOutcome(original)==='available'&&original.buildCommit===expected);
 check('restart replays the same original observation and receives its prior receipt',collector('--flush').uploaded===1&&inspectSpool()[0].receipt.replayed===true);
 const saved=await query<{id:string;payload:unknown;payload_sha256:string}>(sql`SELECT id,payload,payload_sha256 FROM hawa.availability_observations WHERE id=${original.observationId}::uuid`);
 check('one committed row retains the exact original observed evidence',saved.length===1&&isDeepStrictEqual(saved[0].payload,original)&&saved[0].payload_sha256===inspectSpool()[0].receipt.payloadSha256);
 kill('worker-blue');
 try{check('dead worker makes office readiness unavailable despite registered services',(await probe()).body.activeWorker===false);}finally{start('worker-blue');await ready();}
 await nextMinute();kill('core');
 try{const failed=collector();check('real Core outage is retained in the durable upload backlog',failed.pending===1&&inspectSpool().at(-1).payload.probes.office.outcome==='unavailable');}
 finally{start('core');await ready();}
 check('Core restart drains the original pending record once',collector('--flush').uploaded===1&&collector('--flush').uploaded===0);
 await nextMinute();kill('postgres');
 try{const failed=collector();check('real PostgreSQL outage is retained locally without a fabricated success',failed.pending===1&&inspectSpool().at(-1).payload.probes.office.outcome==='unavailable');}
 finally{start('postgres');await closeDb();await ready();}
 check('PostgreSQL recovery accepts the saved outage record exactly once',collector('--flush').uploaded===1&&collector('--flush').uploaded===0);
 await nextMinute();check('later healthy observation continues the original monitor',collector().uploaded===1);
 const history=inspectSpool();check('all four original samples have verified immutable server receipts',history.length===4&&history.every((r:any)=>r.receipt&&r.receipt.observationId===r.payload.observationId));
 const integrity=(await query<{count:number;valid:boolean}>(sql`SELECT count(*)::integer AS count,bool_and(payload_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex')) AS valid
 FROM hawa.availability_observations WHERE monitor_id=${monitor}::uuid`))[0];check('SQL hashes remain valid after both service outages',integrity.count>=4&&integrity.valid);
 check('readiness witness leaves no retained rows',(await query(sql`SELECT id FROM hawa.availability_probe_values`)).length===0);
 const current=await request('/operations/slo');check('monthly report retains failures and unknown time after recovery',parseOperationsReliabilityReport(current.body)!==null&&current.body.availability.unavailableSlots>=2&&current.body.availability.missingSlots>0&&current.body.availability.sloCompliant===null);
 check('monitor credential cannot read office data',(await request('/operations/slo',secrets().CHAOS_AVAILABILITY_SECRET)).status===401);
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100}});await context.addCookies([{name:'hawa_session',value:identity.token,url:origin,httpOnly:true,sameSite:'Strict'},
   {name:'hawa_csrf',value:hash(identity.token+':csrf'),url:origin,sameSite:'Strict'}]);
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/#/ops');const panel=page.getByRole('region',{name:'Office reliability',exact:true});
  await panel.getByText('Known observations available:',{exact:false}).waitFor();
  check('Chrome renders actual coverage, failures and explicit readiness limits',(await panel.innerText()).includes('Coverage:')&&(await panel.innerText()).includes('Not established')&&(await panel.innerText()).includes('do not measure complete user journeys'));
  await panel.scrollIntoViewIfNeeded();await panel.screenshot({path:join(out,'availability-desktop.png')});
  const prior=new Date();prior.setUTCDate(1);prior.setUTCMonth(prior.getUTCMonth()-1);const month=prior.toISOString().slice(0,7);
  await panel.getByLabel('Availability month',{exact:true}).fill(month);await panel.getByText('Completed month · '+month,{exact:false}).waitFor();
  check('historical month stays unknown with no invented past measurements',(await panel.innerText()).includes('Known observations available: Unknown')&&(await panel.innerText()).includes('Not established'));
  await panel.getByRole('button',{name:'Current month',exact:true}).click();await panel.getByText('Provisional month',{exact:false}).waitFor();
  await page.route('**/v1/operations/slo',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Synthetic read failure'})}));
  await page.getByRole('button',{name:'Refresh telemetry',exact:true}).click();await panel.getByText('Reliability evidence unavailable.',{exact:false}).waitFor();
  check('failed browser refresh clears earlier successful evidence',!(await panel.innerText()).includes('Coverage:'));
  await page.unroute('**/v1/operations/slo');await page.getByRole('button',{name:'Refresh telemetry',exact:true}).click();await panel.getByText('Known observations available:',{exact:false}).waitFor();
  await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await panel.screenshot({path:join(out,'availability-mobile.png')});
  const bounds=await panel.locator('p,input,button,small,summary').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth};}));
  writeFileSync(join(out,'mobile-bounds.json'),JSON.stringify(bounds,null,2)+'\n');check('mobile availability fields and evidence fit the viewport',bounds.length>=10&&bounds.every(r=>r.left>=0&&r.right<=r.viewport+1&&r.width>0));
  const cookieOnly=await page.evaluate(async()=>{const r=await fetch('/v1/monitoring/availability/observations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.status;});
  check('office browser cookies cannot upload measurements',cookieOnly===401);check('no browser execution errors',errors.length===0);
 }finally{await browser.close();}
 check('monitoring and recovery made no model requests',await modelCount()===beforeModels);
 check('monitoring and recovery did not create office tasks, requests, approvals or outbox work',JSON.stringify(await officeCounts())===JSON.stringify(beforeOffice));
 await query(sql`UPDATE hawa.tenant_memberships SET active=false WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${identity.userId}::uuid`);
 check('membership revocation immediately denies monthly evidence',[401,403].includes((await request('/operations/slo')).status));
 writeFileSync(join(out,'observations.json'),JSON.stringify(history,null,2)+'\n');writeFileSync(join(out,'report.json'),JSON.stringify(current.body,null,2)+'\n');
 writeFileSync(join(out,'runtime-health.json'),JSON.stringify((await request('/health',secrets().CHAOS_BEARER_TOKEN)).body,null,2)+'\n');completed=true;
}finally{
 await query(sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${hash(identity.token)}`);await closeDb();
 writeFileSync(join(out,'deployed-availability.json'),JSON.stringify({completed,checkedAt:new Date().toISOString(),buildCommit:expected,checks,revokedSyntheticSession:true,productionChanged:false,realProviderCalls:false},null,2)+'\n');
}
console.log(JSON.stringify({passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,evidenceDirectory:out}));
