// Disposable hawa-chaos only; uses synthetic staff authority and no real provider calls.
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {query,secrets,sql,closeDb,FAKES_URL} from '../../../packages/testkit/chaos/driver/stack.js';
import {TENANT_ID} from '../../../packages/testkit/chaos/driver/provision.js';
import {chromium} from '../../../apps/desk/node_modules/@playwright/test/index.mjs';
const expected=process.argv[2];if(!/^[a-f0-9]{40}$/.test(expected||''))throw new Error('Supply exact candidate commit');
const origin='http://127.0.0.1:56081',out=new URL('./',import.meta.url),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const userId=randomUUID(),token=`hawa_sess_${randomUUID().replaceAll('-','')}`,sessionHash=hash(token);
const checks:Array<{name:string;passed:boolean}>=[];
const check=(name:string,passed:boolean)=>{checks.push({name,passed});if(!passed)throw new Error(name);};
const request=async(path:string,body?:unknown,credential=token)=>{
 const r=await fetch(origin+'/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 return {status:r.status,body:await r.json()};
};
const ledger=async()=>((await(await fetch(FAKES_URL+'/__fakes/models/ledger')).json()) as {ledger:unknown[]}).ledger.length;
let completed=false,revoked=false;
try{
 check('exact candidate is deployed',(await request('/health',undefined,secrets().CHAOS_BEARER_TOKEN)).body.buildCommit===expected);
 await query(sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic Operations verifier',${userId})`);
 await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${TENANT_ID}::uuid,${userId}::uuid,'administrator')`);
 await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
  VALUES(${sessionHash},${TENANT_ID}::uuid,${userId}::uuid,'oidc:synthetic-operations','administrator','Synthetic Operations verifier',now()+interval '1 hour','google_oidc')`);
 const before=await ledger();
 const reliability=await request('/operations/slo');
 check('unmeasured availability and latency are explicit',reliability.status===200&&reliability.body.evidenceKind==='unmeasured'&&reliability.body.availability.observedPercent===null&&reliability.body.availability.sloCompliant===null&&reliability.body.latency.p99Ms===null);
 for(const [path,body] of [['/operations/slo/run',{}],['/clients/budgets',undefined],['/clients/client-drustee/budget',undefined],['/clients/client-drustee/budget/allocate',{capUsd:999}]] as const)
  check(`retired endpoint refuses ${path}`,(await request(path,body)).status===410);
 const policy=await request('/spending/policy');check('named daily policy still reads authoritative data',policy.status===200&&policy.body.canEdit===true&&Number.isInteger(policy.body.current.version));
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.addCookies([{name:'hawa_session',value:token,url:origin,httpOnly:true,sameSite:'Strict'},
   {name:'hawa_csrf',value:hash(`${token}:csrf`),url:origin,sameSite:'Strict'}]);
  const page=await context.newPage(),errors:string[]=[],requests:Array<{url:string;method:string}>=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  await page.goto(origin+'/#/ops');await page.getByText('Availability unmeasured',{exact:true}).waitFor();
  check('Chrome shows the monthly target without a compliance claim',(await page.locator('#ops').innerText()).includes('99.5% monthly availability'));
  check('no fixture budget or benchmark controls remain',!(await page.locator('#ops').innerText()).match(/Monthly Spend|Langfuse|Helicone|SLO: COMPLIANT|Run Synthetic Benchmark/));
  await page.getByRole('button',{name:'Review budget policy',exact:true}).click();
  await page.getByRole('heading',{name:`Current policy · revision ${policy.body.current.version}`,exact:true}).waitFor();
  check('Chrome policy controls use current PostgreSQL limits',Number(await page.getByLabel('Office daily limit',{exact:true}).inputValue())===policy.body.current.limits.officeUsd);
  check('reading Operations and policy makes no mutation',requests.every(r=>r.method!=='POST'));
  await page.screenshot({path:new URL('policy-browser.png',out).pathname,fullPage:true});
  await page.getByRole('button',{name:'Hide budget policy',exact:true}).click();
  const auditResponse=page.waitForResponse(r=>r.url().endsWith('/operations/reconciliation/run')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Run Reconciliation Audit',exact:true}).click();
  const audit=await(await auditResponse).json();
  await page.getByText(`Audit recorded ${audit.timestamp} · Stored receipt evidence`,{exact:true}).waitFor();
  check('audit presents its actual PostgreSQL receipt basis',audit.simulated===false&&(await page.locator('#ops').innerText()).includes(audit.basis));
  check('audit anomalies are never called repaired',!(await page.locator('#ops').innerText()).match(/Drifts Repaired|100% In Sync/));
  await page.route('**/v1/operations/reconciliation',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Synthetic unavailable read'})}));
  await page.getByRole('button',{name:'Refresh telemetry',exact:true}).click();
  await page.getByText('No audit read',{exact:true}).waitFor();
  check('failed refresh removes earlier successful audit',!((await page.locator('#ops').innerText()).includes(`Audit recorded ${audit.timestamp}`)));
  await page.unroute('**/v1/operations/reconciliation');
  await page.getByRole('button',{name:'Refresh telemetry',exact:true}).click();
  await page.getByText(`Audit recorded ${audit.timestamp} · Stored receipt evidence`,{exact:true}).waitFor();
  check('successful refresh restores real receipt evidence',true);
  check('Desk never calls retired monthly budget endpoints',!requests.some(r=>/\/clients\/budgets|\/budget(?:\/allocate)?$/.test(r.url)));
  check('browser credentials stay out of localStorage',await page.evaluate(()=>localStorage.getItem('hawa_operator_token')===null));
  await page.screenshot({path:new URL('operations-browser.png',out).pathname,fullPage:true});
  writeFileSync(new URL('browser-operations.txt',out),await page.locator('#ops').innerText());
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:new URL('operations-mobile.png',out).pathname,fullPage:true});
  check('mobile Operations fits the viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  check('Chrome has no execution errors',errors.length===0);
 }finally{await browser.close();}
 check('Operations checks send no model requests',await ledger()===before);
 writeFileSync(new URL('runtime-health.json',out),JSON.stringify((await request('/health')).body,null,2)+'\n');
 completed=true;
}finally{
 await query(sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${sessionHash}`);revoked=true;await closeDb();
 writeFileSync(new URL('deployed-operations.json',out),JSON.stringify({completed,checkedAt:new Date().toISOString(),buildCommit:expected,checks,revokedSyntheticAdministrator:revoked,productionChanged:false,realProviderCalls:false},null,2)+'\n');
}
console.log(JSON.stringify({passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length}));
