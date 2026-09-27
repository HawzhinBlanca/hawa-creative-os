// Disposable hawa-chaos only; synthetic staff, fake providers, real Core restart and Chrome.
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {query,secrets,sql,closeDb,FAKES_URL,compose} from '../../../packages/testkit/chaos/driver/stack.js';
import {TENANT_ID} from '../../../packages/testkit/chaos/driver/provision.js';
import {chromium} from '../../../apps/desk/node_modules/@playwright/test/index.mjs';
import {parseReceiptAuditState,parseStoredReceiptAudit,type ReceiptAuditAction,type StoredReceiptAudit} from '../../../packages/contracts/src/publication-audit.js';
const expected=process.argv[2];if(!/^[a-f0-9]{40}$/.test(expected||''))throw new Error('Supply exact candidate commit');
const origin='http://127.0.0.1:56081',out=new URL('./',import.meta.url),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const identities=['administrator','designer'].map(role=>({role,userId:randomUUID(),token:`hawa_sess_${randomUUID().replaceAll('-','')}`}));
const [a,b]=identities,clientId=randomUUID(),foreignTaskId=randomUUID();
const checks:Array<{name:string;passed:boolean}>=[];
const check=(name:string,passed:boolean)=>{checks.push({name,passed});if(!passed)throw new Error(name);};
const request=async(path:string,body?:Record<string,unknown>,credential=a.token,headers:Record<string,string>={})=>{
 const r=await fetch(origin+'/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json',
  ...(typeof body?.actionId==='string'?{'Idempotency-Key':body.actionId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 return {status:r.status,body:await r.json(),cacheControl:r.headers.get('Cache-Control')};
};
const ledger=async()=>((await(await fetch(FAKES_URL+'/__fakes/models/ledger')).json()) as {ledger:unknown[]}).ledger.length;
const auditPath='/operations/reconciliation',runPath=auditPath+'/run';
let completed=false,revoked=false,original:StoredReceiptAudit|null=null,originalAction:ReceiptAuditAction|null=null;
try{
 check('exact candidate is deployed',(await request('/health',undefined,secrets().CHAOS_BEARER_TOKEN)).body.buildCommit===expected);
 for(const who of identities){
  await query(sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${who.userId}::uuid,${who.userId+'@example.test'},'Synthetic receipt audit verifier',${who.userId})`);
  await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${TENANT_ID}::uuid,${who.userId}::uuid,${who.role}::hawa.membership_role)`);
  await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
   VALUES(${hash(who.token)},${TENANT_ID}::uuid,${who.userId}::uuid,${'oidc:'+who.userId},${who.role},'Synthetic receipt audit verifier',now()+interval '1 hour','google_oidc')`);
 }
 await query(sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${TENANT_ID}::uuid,${clientId},'Synthetic isolated audit client')`);
 await query(sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${TENANT_ID}::uuid,${clientId}::uuid,${b.userId}::uuid,'designer')`);
 await query(sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state) VALUES(${foreignTaskId}::uuid,${TENANT_ID}::uuid,${clientId}::uuid,'Synthetic unconfirmed delivery','complete')`);
 const before=await ledger(),initial=await request(auditPath);
 check('named scope starts with empty durable history and no-store',initial.status===200&&parseReceiptAuditState(initial.body)!==null&&initial.body.latest===null&&initial.cacheControl==='no-store');
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.addCookies([{name:'hawa_session',value:a.token,url:origin,httpOnly:true,sameSite:'Strict'},
   {name:'hawa_csrf',value:hash(`${a.token}:csrf`),url:origin,sameSite:'Strict'}]);
  const page=await context.newPage(),errors:string[]=[],posts:ReceiptAuditAction[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith(runPath))posts.push(r.postDataJSON());});
  await page.goto(origin+'/#/ops');await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  const panel=page.getByRole('region',{name:'Stored publication receipt audit',exact:true});
  await panel.getByLabel('Audit reason',{exact:true}).waitFor();
  check('Chrome shows identity-scoped receipt history without repairs',(await panel.innerText()).includes('History belongs to your current identity')&&(await panel.innerText()).includes('nothing is repaired'));
  await page.route('**/v1/operations/reconciliation/run',async route=>{
   originalAction=route.request().postDataJSON();const response=await route.fetch();original=parseStoredReceiptAudit(await response.json());
   check('lost browser response follows a real committed audit',response.status()===201&&original!==null);
   await route.abort('failed');
  });
  await panel.getByLabel('Audit reason',{exact:true}).fill('Inspect stored receipts after an uncertain delivery');
  await panel.getByRole('button',{name:'Run receipt audit',exact:true}).click();
  await panel.getByText('Audit not confirmed:',{exact:false}).waitFor();
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('lost-response.png',out).pathname});
  await page.unroute('**/v1/operations/reconciliation/run');
  await page.reload();await panel.getByRole('button',{name:'Retry saved audit',exact:true}).waitFor();
  const replayResponse=page.waitForResponse(r=>r.url().endsWith(runPath)&&r.request().method()==='POST');
  await panel.getByRole('button',{name:'Retry saved audit',exact:true}).click();
  const replay=await replayResponse,recovered=await replay.json();
  await panel.getByText('Original audit recovered. No new audit was created.',{exact:true}).waitFor();
  check('Chrome reload retries the original body and recovers one identity',replay.status()===200&&recovered.replayed===true&&
   recovered.auditId===original!.auditId&&JSON.stringify(posts[0])===JSON.stringify(posts[1]));
  const integrity=(await query<{count:number;ok:boolean}>(sql`SELECT count(*)::integer AS count,bool_and(inputs_sha256=encode(sha256(convert_to(inputs::text,'UTF8')),'hex') AND
   report_sha256=encode(sha256(convert_to(report::text,'UTF8')),'hex')) AS ok FROM hawa.receipt_audits WHERE tenant_id=${TENANT_ID}::uuid AND actor_user_id=${a.userId}::uuid`))[0];
  check('one original durable audit has recomputable input and report hashes',integrity.count===1&&integrity.ok);
  const first=original!;
  check('current scope includes the synthetic incomplete delivery',first.anomalies.some(x=>x.taskId===foreignTaskId)&&first.simulated===false);
  compose(['restart','core'],{timeoutMs:60000});
  let ready=false;for(let i=0;i<40;i++){
   try{ready=(await request('/health')).body.buildCommit===expected;}catch{}
   if(ready)break;await new Promise(r=>setTimeout(r,500));
  }
  check('Core returns with the exact build after a real container restart',ready);
  await page.reload();await panel.getByText(`Audit recorded ${first.timestamp} · Revision ${first.revision} · Stored receipt evidence`,{exact:true}).waitFor();
  check('browser sees the same PostgreSQL report after Core restart',(await request(auditPath)).body.latest.auditId===first.auditId);
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('after-restart.png',out).pathname});
  await panel.getByLabel('Audit reason',{exact:true}).fill('Inspect a second snapshot');
  const secondResponse=page.waitForResponse(r=>r.url().endsWith(runPath)&&r.request().method()==='POST');
  await panel.getByRole('button',{name:'Run receipt audit',exact:true}).click();const second=await(await secondResponse).json();
  await panel.getByText(`Audit recorded ${second.timestamp} · Revision 2 · Stored receipt evidence`,{exact:true}).waitFor();
  await panel.getByText('Audit history',{exact:true}).click();await panel.getByRole('button',{name:'View audit 1',exact:true}).click();
  check('history opens the original report after a later audit',(await panel.innerText()).includes(`Audit recorded ${first.timestamp} · Revision 1`));
  const replayOlder=await request(runPath,originalAction!);
  check('replaying an older action retains the latest history head',replayOlder.status===200&&replayOlder.body.auditId===first.auditId&&(await request(auditPath)).body.latest.auditId===second.auditId);
  const stateB=(await request(auditPath,undefined,b.token)).body;
  check('another actor cannot read the administrator audit',stateB.latest===null&&stateB.history.length===0&&stateB.scope.clientIds.length===1);
  const actionB={actionId:randomUUID(),expectedScopeSha256:stateB.scope.sha256,expectedLatestAuditId:null,reason:'Inspect own assigned client'};
  const reportB=await request(runPath,actionB,b.token);
  const allowedIds=new Set((await query<{id:string}>(sql`SELECT id FROM hawa.tasks WHERE tenant_id=${TENANT_ID}::uuid AND (client_id=${clientId}::uuid OR client_id IS NULL)`)).map(t=>t.id));
  check('designer audit contains only assigned and unassigned tasks',reportB.status===201&&reportB.body.actorUserId===b.userId&&reportB.body.totalTasksAudited===allowedIds.size&&reportB.body.anomalies.every((x:{taskId:string})=>allowedIds.has(x.taskId)));
  check('administrator history does not expose another actor audit',(await request(auditPath)).body.history.every((x:StoredReceiptAudit)=>x.actorUserId===a.userId));
  await query(sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${b.userId}::uuid`);
  const revokedScope=(await request(auditPath,undefined,b.token)).body;
  check('revocation removes old reports from latest and history',revokedScope.latest===null&&revokedScope.history.length===0&&revokedScope.scope.sha256!==stateB.scope.sha256);
  check('revoked-scope action cannot be replayed',(await request(runPath,actionB,b.token)).status===409);
  await query(sql`UPDATE hawa.tenant_memberships SET active=false WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${b.userId}::uuid`);
  check('inactive office membership cannot read audit state',[401,403].includes((await request(auditPath,undefined,b.token)).status));
  const current=(await request(auditPath)).body,negative={actionId:randomUUID(),expectedScopeSha256:current.scope.sha256,expectedLatestAuditId:current.latest.auditId,reason:'Synthetic refusal'};
  check('different header identity is refused',(await request(runPath,negative,a.token,{'Idempotency-Key':randomUUID()})).status===400);
  check('browser supplied rows are refused',(await request(runPath,{...negative,driveFiles:[]})).status===422);
  check('automatic repair is refused',(await request(runPath,{...negative,autoRepair:true})).status===422);
  const csrf=await page.evaluate(async body=>{const response=await fetch('/v1/operations/reconciliation/run',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':body.actionId},body:JSON.stringify(body)});return response.status;},negative);
  check('cookie mutation without CSRF proof is refused',csrf===403);
  await page.route('**/v1/operations/reconciliation',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Synthetic read outage'})}));
  await panel.getByRole('button',{name:'Reload receipt audits',exact:true}).click();await panel.getByText('Receipt audit evidence unavailable:',{exact:false}).waitFor();
  check('failed browser read clears report and history',!(await panel.innerText()).includes('Audit recorded')&&await panel.getByRole('button',{name:'View audit 1',exact:true}).count()===0);
  await page.unroute('**/v1/operations/reconciliation');await panel.getByRole('button',{name:'Reload receipt audits',exact:true}).click();
  await panel.getByText(`Audit recorded ${second.timestamp} · Revision 2 · Stored receipt evidence`,{exact:true}).waitFor();
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('audit-desktop.png',out).pathname});
  await page.setViewportSize({width:390,height:844});
  await panel.getByLabel('Audit reason',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:new URL('audit-mobile-form.png',out).pathname});
  await panel.locator('.ops-audit-stats').scrollIntoViewIfNeeded();await page.screenshot({path:new URL('audit-mobile-report.png',out).pathname});
  const bounds=await panel.locator('.stat, textarea, button').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>{
   const r=e.getBoundingClientRect();return {label:e.textContent?.trim().slice(0,80),left:r.left,right:r.right,width:r.width,viewport:innerWidth};
  }));
  writeFileSync(new URL('mobile-bounds.json',out),JSON.stringify(bounds,null,2)+'\n');
  check('mobile audit fields, counters and actions fit without clipped children',bounds.length>=9&&bounds.every(r=>r.width>0&&r.left>=0&&r.right<=r.viewport+1));
  check('browser credentials and resolved audit action do not remain in browser storage',await page.evaluate(()=>localStorage.getItem('hawa_operator_token')===null&&!Object.keys(sessionStorage).some(k=>k.startsWith('hawa.receipt-audit.'))));
  check('no browser execution errors',errors.length===0);
 }finally{await browser.close();}
 check('receipt audits, restart and retries send no model requests',await ledger()===before);
 writeFileSync(new URL('runtime-health.json',out),JSON.stringify((await request('/health')).body,null,2)+'\n');
 completed=true;
}finally{
 for(const who of identities)await query(sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${hash(who.token)}`);
 revoked=true;await closeDb();
 writeFileSync(new URL('deployed-audits.json',out),JSON.stringify({completed,checkedAt:new Date().toISOString(),buildCommit:expected,checks,
  originalReport:original,originalAction,revokedSyntheticSessions:revoked,productionChanged:false,realProviderCalls:false},null,2)+'\n');
}
console.log(JSON.stringify({passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length}));
