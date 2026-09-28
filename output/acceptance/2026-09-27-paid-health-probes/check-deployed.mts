// Disposable hawa-chaos only. Synthetic receipts and authority, never real invoices.
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {withRlsContext} from '../../../packages/db/dist/index.js';
import {db,query,secrets,sql,closeDb,FAKES_URL,compose} from '../../../packages/testkit/chaos/driver/stack.js';
import {TENANT_ID} from '../../../packages/testkit/chaos/driver/provision.js';
import {waitUntil} from '../../../packages/testkit/chaos/driver/scenario.js';
import {chromium} from '../../../apps/desk/node_modules/@playwright/test/index.mjs';
let completed=false;
const expected=process.argv[2];if(!/^[a-f0-9]{40}$/.test(expected||''))throw new Error('Supply the exact deployed candidate commit');
const origin='http://127.0.0.1:56081',out=new URL('./',import.meta.url),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const checks:Array<{name:string;passed:boolean}>=[];
const check=(name:string,ok:boolean)=>{checks.push({name,passed:ok});if(!ok)throw new Error(name);};
const userId=randomUUID(),token=`hawa_sess_${randomUUID().replaceAll('-','')}`,sessionHash=hash(token);
const request=async(path:string,body?:unknown,action?:string,credential=token)=>{
  const r=await fetch(origin+'/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json',...(action?{'Idempotency-Key':action}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  return {status:r.status,body:await r.json()};
};
const ledger=async()=>((await(await fetch(FAKES_URL+'/__fakes/models/ledger')).json()) as {ledger:unknown[]}).ledger.length;
let revoked=false;
try{
  check('exact candidate is deployed',(await request('/health',undefined,undefined,secrets().CHAOS_BEARER_TOKEN)).body.buildCommit===expected);
  check('migration055 is installed',(await query(sql`SELECT name FROM hawa.schema_upgrades WHERE name='055_durable_paid_health_probes.sql'`)).length===1);
  await query(sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic accounting verifier',${userId})`);
  await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${TENANT_ID}::uuid,${userId}::uuid,'administrator')`);
  await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${sessionHash},${TENANT_ID}::uuid,${userId}::uuid,'oidc:synthetic-accounting','administrator','Synthetic accounting verifier',now()+interval '1 hour','google_oidc')`);
  const executeProbe=(loseResponse=false)=>{
    const program=`import {createDb} from '@hawa/db';
      import {PaidModelProbeService} from './dist/services/paid-model-probe.js';
      const db=createDb(process.env.DATABASE_URL);
      const transport=${loseResponse ? "async(...args)=>{const r=await fetch(...args);await r.text();throw new Error('synthetic lost success');}" : 'fetch'};
      try {const result=await new PaidModelProbeService(db,transport).execute(
        {tenantId:'${TENANT_ID}',userId:'${userId}',role:'administrator'},process.env.OPENAI_API_KEY,'gpt-4.1-mini',300000);
        console.log(JSON.stringify(result));} finally {await db.destroy();}`;
    return JSON.parse(compose(['exec','-T','core','node','--input-type=module','-e',program]).stdout.trim());
  };
  const firstRequests=await ledger(),attempt=executeProbe(true),callId=attempt.callId;
  check('deployed code records a lost successful fake response',attempt.dispatched&&attempt.status==='unreachable'&&typeof callId==='string');
  check('one actual synthetic provider request was received',await ledger()===firstRequests+1);
  check('second scheduler refuses dispatch',executeProbe().status==='reconciliation_required');
  const original=async()=> (await query<{digest:string}>(sql`SELECT encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex') AS digest FROM hawa.paid_model_probe_calls c WHERE id=${callId}::uuid`))[0].digest;
  const before=await original(),beforeRequests=await ledger(),path=`/spending/calls/health_probe/${callId}`,initial=await request(path);
  check('uncertain probe cost is held and named correction is available',initial.status===200&&initial.body.requiresCostEvidence&&initial.body.originalCostUsd===null&&initial.body.canRecord);
  const invalid={expectedSnapshot:initial.body.snapshotHash,reason:'Synthetic control',calls:[{callId,conclusion:'provider_finished',reportedCostUsd:.004,evidenceReference:'synthetic-loopback-unbilled',evidenceSha256:hash('synthetic accounting evidence')}]};
  check('shared administrator key cannot attest',(await request(path+'/evidence',invalid,randomUUID(),secrets().CHAOS_ADMIN_KEY)).status===403);
  check('stale snapshot is refused',(await request(path+'/evidence',{...invalid,expectedSnapshot:'0'.repeat(64)},randomUUID())).status===409);
  const foreign=await fetch(origin+'/v1'+path+'/evidence',{method:'POST',headers:{
    Cookie:`hawa_session=${token}; hawa_csrf=${hash(`${token}:csrf`)}`,'x-hawa-csrf':hash(`${token}:csrf`),
    Origin:'http://127.0.0.1:56082','Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(invalid)});
  check('cookie mutation still refuses a different browser port',foreign.status===403);
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  let savedBody:unknown,savedAction:string|undefined;
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    await context.addCookies([{name:'hawa_session',value:token,url:origin,httpOnly:true,sameSite:'Strict'},
      {name:'hawa_csrf',value:hash(`${token}:csrf`),url:origin,sameSite:'Strict'}]);
    const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith(path+'/evidence')){savedBody=r.postDataJSON();savedAction=r.headers()['idempotency-key'];}});
    await page.goto(origin+'/#/ops');
    await page.getByRole('button',{name:'Review call costs',exact:true}).click();
    const panel=page.getByRole('region',{name:'Call cost accounting',exact:true});
    await panel.getByRole('button',{name:'Review '+callId.slice(0,8),exact:true}).click();
    const selected=page.getByRole('region',{name:'Selected call accounting',exact:true});
    await selected.getByRole('heading',{name:'Record final call cost',exact:true}).waitFor();
    check('browser displays original uncertain outcome and unknown cost',(await selected.innerText()).includes('Original outcome: unreachable')&&(await selected.innerText()).includes('Unknown'));
    check('browser explains new-probe recovery boundary',(await selected.innerText()).includes('Terminal evidence permits a new scheduled health probe'));
    await selected.getByLabel('Call 1 final cost',{exact:true}).fill('0.004');
    await selected.getByLabel('Call 1 evidence reference',{exact:true}).fill('synthetic-loopback-unbilled');
    await selected.getByLabel('Call 1 evidence hash',{exact:true}).fill(hash('synthetic accounting evidence'));
    await selected.getByLabel('Settlement reason',{exact:true}).fill('Synthetic provider accounting evidence; no real billing');
    const response=page.waitForResponse(r=>r.url().endsWith(path+'/evidence')&&r.request().method()==='POST');
    await selected.getByRole('button',{name:'Record cost evidence',exact:true}).click();
    const recorded=await response;
    if(recorded.status()!==200){
      writeFileSync(new URL('browser-refusal.json',out),JSON.stringify({status:recorded.status(),body:await recorded.json()},null,2)+'\n');
      await selected.screenshot({path:new URL('accounting-browser-refusal.png',out).pathname});
    }
    check('named browser mutation succeeds with cookie CSRF',recorded.status()===200);
    await selected.getByText('Accounting history (1)',{exact:true}).waitFor();
    await selected.getByText('Accounting history (1)',{exact:true}).click();
    check('browser shows attributed cost history',(await selected.innerText()).includes(userId)&&(await selected.innerText()).includes('$0.004000'));
    check('browser has no execution errors',errors.length===0);
    check('credentials stay out of localStorage',await page.evaluate(()=>localStorage.getItem('hawa_operator_token')===null));
    await page.setViewportSize({width:1440,height:1600});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:new URL('accounting-browser.png',out).pathname,fullPage:true});
    writeFileSync(new URL('browser-accounting.txt',out),await selected.innerText());
    await selected.getByRole('button',{name:'Reload selected call',exact:true}).click();
    await selected.getByText('Accounting history (1)',{exact:true}).waitFor();check('browser reload preserves history',true);
    await selected.getByRole('button',{name:'Close call',exact:true}).click();await selected.waitFor({state:'detached'});check('browser closes call detail',true);
  }finally{await browser.close();}
  const after=await request(path);
  check('cost evidence releases the unused reservation',after.status===200&&!after.body.requiresCostEvidence&&after.body.accountedCostUsd===.004&&after.body.revision===1);
  check('original call remains byte-for-byte unchanged',await original()===before);
  check('browser dispatched an identifiable saved action',!!savedAction&&!!savedBody);
  compose(['restart','core']);
  await waitUntil('Core restarts after exact-call cost evidence',async()=>{try{return (await request(path)).status===200;}catch{return false;}});
  check('fresh scheduler still honors interval after terminal evidence',executeProbe().status==='not_due');
  const replay=await request(path+'/evidence',savedBody,savedAction);
  check('same action replays after actual Core restart',replay.status===200&&replay.body.replayed===true&&replay.body.receipt.revision===1);
  check('restart leaves one accounting revision',(await request(path)).body.attestations.length===1);
  check('accounting and replay send zero fake model requests',await ledger()===beforeRequests);
  writeFileSync(new URL('runtime-health.json',out),JSON.stringify((await request('/health')).body,null,2)+'\n');
  completed=true;
}finally{
  await query(sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${sessionHash}`);revoked=true;
  await closeDb();
  writeFileSync(new URL('deployed-paid-probe.json',out),JSON.stringify({completed,checkedAt:new Date().toISOString(),buildCommit:expected,checks,revokedSyntheticAdministrator:revoked,scope:'Disposable hawa-chaos synthetic source/provider/staff only',realProviderCalls:false,productionChanged:false},null,2)+'\n');
}
console.log(JSON.stringify({passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length}));
