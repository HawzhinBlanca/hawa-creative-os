import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import {createDb,sql,withRlsContext} from '@hawa/db';
import {FeedbackMiner,planRuleModeration} from '@hawa/creative';
import {createAppWithClientFixtures} from './fixtures/app-with-client-fixtures.js';
import {approvedRefinementPair} from './fixtures/approved-refinement-pair.js';
import {memoryExportStore} from './pinned-exports-fixture.js';
import { mkdtemp, rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work=await mkdtemp(join(tmpdir(),'hawa-learning-recovery-'));
const clientId='c1000000-0000-4000-8000-000000000003';
const headers={'Content-Type':'application/json',Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`};
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
const tenantId='00000000-0000-4000-a000-000000000001',actorId='00000000-0000-4000-b000-000000000002';
const children=new Set<ChildProcess>();
let child:ChildProcess|undefined;
async function stop(signal:'SIGKILL'|'SIGTERM'='SIGTERM',target=child) {
  child=target;
  if(!child || child.exitCode!==null || child.signalCode!==null) return;
  const exiting=once(child,'exit'),processToStop=child;processToStop.kill(signal);
  const fallback=setTimeout(()=>processToStop.kill('SIGKILL'),5000);
  try {const [,actual]=await exiting;if(signal==='SIGKILL') expect(actual).toBe('SIGKILL');}
  finally {clearTimeout(fallback);children.delete(processToStop);child=undefined;}
}
async function start() {
  let stderr='';
  child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),
    fileURLToPath(new URL('./fixtures/learning-recovery-process.ts',import.meta.url))],{
      cwd:work,stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH,NODE_ENV:'test',VITEST:'true',
        HAWA_LEARNING_RECOVERY:'1',TEST_DATABASE_URL:process.env.TEST_DATABASE_URL,
        HAWA_ART_DIRECTOR_KEY:process.env.HAWA_ART_DIRECTOR_KEY,HAWA_ADMIN_KEY:process.env.HAWA_ADMIN_KEY,
        HAWA_BEARER_TOKEN:process.env.HAWA_BEARER_TOKEN,HAWA_ACTION_HMAC_SECRET:randomUUID(),
        DESIGN_PIPELINE_V3:'off',DESIGN_STUDIO_V2:'off',
      },
    });
  children.add(child);
  child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-1000);});
  const running=child;
  const port=await new Promise<number>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Recovery Core startup timed out')),10000);
    running.once('message',(message:{port:number})=>{clearTimeout(timer);resolve(message.port);});
    running.once('exit',()=>{clearTimeout(timer);reject(new Error(`Recovery Core stopped before readiness: ${stderr}`));});
  });
  return Object.assign((path:string,init?:RequestInit)=>fetch(`http://127.0.0.1:${port}/v1${path}`,{
    ...init,headers:{...headers,...init?.headers},signal:AbortSignal.timeout(10000),
  }),{process:running});
}
afterAll(async()=>{for(const process of children) await stop('SIGTERM',process);await rm(work,{recursive:true,force:true});await db.destroy();await owner.destroy();});
describe('Learning recovery across independent Core processes',()=>{
  it('retains pending instructions and cold moderation after an actual SIGKILL',async()=>{
    let send=await start();
    const action=randomUUID(),body={title:'Cold process instruction',category:'layout',ruleText:'Keep a deliberate hierarchy'};
    const propose=await send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers:{'Idempotency-Key':action},body:JSON.stringify(body)});
    expect(propose.status).toBe(201);const original=(await propose.json()).proposal;
    await stop('SIGKILL');send=await start();
    const list=await send(`/clients/${clientId}/candidate-rules`);expect(list.status).toBe(200);
    expect((await list.json()).candidateRules).toContainEqual(original);
    const replay=await send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers:{'Idempotency-Key':action},body:JSON.stringify(body)});
    expect(replay.status).toBe(200);expect((await replay.json()).proposal.id).toBe(original.id);
    const changed=await send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers:{'Idempotency-Key':action},
      body:JSON.stringify({...body,ruleText:'Changed key reuse'})});expect(changed.status).toBe(409);
    const promote=await send(`/clients/${clientId}/candidate-rules/${original.id}/promote`,{method:'POST',body:'{}'});
    expect(promote.status).toBe(200);
    await stop('SIGKILL');send=await start();
    const rollback=await send(`/clients/${clientId}/candidate-rules/${original.id}/rollback`,{method:'POST',body:'{}'});
    expect(rollback.status).toBe(200);
    await stop('SIGKILL');send=await start();
    const after=await send(`/clients/${clientId}/candidate-rules`);
    expect((await after.json()).candidateRules).toContainEqual(expect.objectContaining({id:original.id,status:'DISMISSED'}));
    expect((await send(`/clients/c1000000-0000-4000-8000-000000000002/candidate-rules/${original.id}/promote`,{method:'POST',body:'{}'})).status).toBe(404);
  },30000);
  it('recovers committed approved revisions and rejection without inflating support',async()=>{
    const exports=memoryExportStore(),app=createAppWithClientFixtures({db,deliverableStore:exports.store});
    const pair=await approvedRefinementPair(app,headers,clientId,exports);
    let send=await start();const key=randomUUID();
    const mine=()=>send('/feedback/mine',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(pair)});
    const initial=await mine();expect(initial.status).toBe(201);
    const original=(await initial.json()).proposedRules[0];expect(original).toBeDefined();
    await stop('SIGKILL');send=await start();
    let list=await send(`/clients/${clientId}/candidate-rules`);
    expect((await list.json()).candidateRules).toContainEqual(original);
    expect((await mine()).status).toBe(200);
    const beforeKey=randomUUID(),beforeRejection={taskId:pair.taskId,revisionId:pair.beforeRevisionId,feedbackText:'Reject only the earlier revision'};
    const rejectRevision=(body:unknown,key=beforeKey)=>send(`/clients/${clientId}/negative-feedback`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});
    expect((await rejectRevision(beforeRejection)).status).toBe(201);
    expect((await rejectRevision({...beforeRejection,revisionId:pair.afterRevisionId})).status).toBe(409);
    expect((await rejectRevision({...beforeRejection,revisionId:randomUUID()},randomUUID())).status).toBe(409);
    await stop('SIGKILL');send=await start();
    expect((await rejectRevision(beforeRejection)).status).toBe(200);
    list=await send(`/clients/${clientId}/candidate-rules`);
    const corrected=(await list.json()).candidateRules.find((r:{id:string})=>r.id===original.id);
    expect(corrected.examples.positiveExampleTaskIds).toContain(pair.taskId);
    expect(corrected.examples.positiveExamples).toContainEqual(expect.objectContaining({target:expect.objectContaining({kind:'design_revision',revisionId:pair.afterRevisionId}),basis:'revision_decision'}));
    expect(corrected.examples.negativeExamples).toContainEqual(expect.objectContaining({feedbackId:beforeKey,target:expect.objectContaining({revisionId:pair.beforeRevisionId})}));
    const decisions=(await sql<{id:string}>`SELECT id FROM hawa.feedback_events WHERE task_id=${pair.taskId}::uuid AND category='decision.approved'`.execute(owner)).rows;
    expect(decisions).toHaveLength(1);
    await expect(sql`UPDATE hawa.feedback_events SET comment='changed approval' WHERE id=${decisions[0].id}::uuid`.execute(owner)).rejects.toMatchObject({code:'55000'});
    const rejection=await send(`/clients/${clientId}/negative-feedback`,{method:'POST',headers:{'Idempotency-Key':randomUUID()},
      body:JSON.stringify({taskId:pair.taskId,feedbackText:'Reject this reviewed result for current use'})});expect(rejection.status).toBe(201);
    await stop('SIGKILL');send=await start();list=await send(`/clients/${clientId}/candidate-rules`);
    const recovered=(await list.json()).candidateRules.find((r:{id:string})=>r.id===original.id);
    expect(recovered.frequency).toBe(1);expect(recovered.examples.negativeExampleTaskIds).toContain(pair.taskId);
    expect(recovered.examples.positiveExampleTaskIds).not.toContain(pair.taskId);
    expect(recovered.refinementEvidence[0].actor).toMatchObject({id:actorId,role:'art_director'});
    await stop();
  },30000);
  it('preserves independent Studio targets and rating observations across a real crash',async()=>{
    const task=randomUUID(),run=randomUUID(),candidateA=randomUUID(),candidateB=randomUUID();
    const bytes=Buffer.from('isolated polarity picture'),sha=createHash('sha256').update(bytes).digest('hex');
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${task}::uuid,${tenantId}::uuid,${clientId}::uuid,'Polarity source')`.execute(owner);
    await sql`INSERT INTO hawa.design_studio_runs(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,tier,status,budget,stages)
      VALUES(${run}::uuid,${tenantId}::uuid,${task}::uuid,${clientId}::uuid,${actorId}::uuid,${randomUUID()},'hash','{}','standard','briefing','{"maxUsd":6,"maxCalls":40,"spentUsd":0,"calls":0}','{}')`.execute(owner);
    for(const [ordinal,id] of [candidateA,candidateB].entries()) await sql`INSERT INTO hawa.design_studio_candidates(id,run_id,tenant_id,ordinal,concept,status,preview_png,preview_sha256)
      VALUES(${id}::uuid,${run}::uuid,${tenantId}::uuid,${ordinal},'{}','draft',${bytes},${sha})`.execute(owner);
    let send=await start();
    const rating=randomUUID(),rejected=randomUUID(),accepted=randomUUID();
    const review=(candidateId:string,verdict:string,key:string,notes:string|null,ratingValue?:number)=>send(`/tasks/${task}/design-feedback`,{
      method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({runId:run,candidateId,previewSha256:sha,verdict,notes:notes??undefined,...(ratingValue?{rating:ratingValue}:{})})});
    expect((await review(candidateA,'rating',rating,'Deliberate hierarchy for candidate A',9)).status).toBe(201);
    expect((await review(candidateA,'reject',rejected,null)).status).toBe(201);
    expect((await review(candidateB,'approve',accepted,'Deliberate hierarchy for candidate B')).status).toBe(201);
    await stop('SIGKILL');send=await start();
    const response=await send(`/clients/${clientId}/candidate-rules`);expect(response.status).toBe(200);
    const rules=(await response.json()).candidateRules;
    const a=rules.find((r:{provenance:{feedbackId:string}})=>r.provenance.feedbackId===rating);
    const b=rules.find((r:{provenance:{feedbackId:string}})=>r.provenance.feedbackId===accepted);
    expect(a.examples.positiveExamples).toEqual([]);
    expect(a.examples.negativeExamples).toContainEqual(expect.objectContaining({feedbackId:rejected,target:expect.objectContaining({candidateId:candidateA})}));
    expect(b.examples.positiveExamples).toContainEqual(expect.objectContaining({feedbackId:accepted,target:expect.objectContaining({candidateId:candidateB})}));
    expect(b.examples.negativeExamples).toEqual([]);
    expect((await review(candidateB,'approve',accepted,'Deliberate hierarchy for candidate B')).status).toBe(200);
    expect((await review(candidateA,'approve',randomUUID(),null)).status).toBe(201);
    const later=await send(`/clients/${clientId}/candidate-rules`);
    expect((await later.json()).candidateRules.find((r:{id:string})=>r.id===a.id).examples.positiveExamples).toEqual([]);
    await stop();
  },30000);
  it('retains Studio reviewer attribution, source immutability and legacy unknown roles',async()=>{
    const task=randomUUID(),run=randomUUID(),candidate=randomUUID(),key=randomUUID(),legacy=randomUUID();
    const bytes=Buffer.from('isolated saved picture'),sha=createHash('sha256').update(bytes).digest('hex');
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${task}::uuid,${tenantId}::uuid,${clientId}::uuid,'Recovery source')`.execute(owner);
    await sql`INSERT INTO hawa.design_studio_runs(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,tier,status,budget,stages)
      VALUES(${run}::uuid,${tenantId}::uuid,${task}::uuid,${clientId}::uuid,${actorId}::uuid,${randomUUID()},'hash','{}','standard','briefing','{"maxUsd":6,"maxCalls":40,"spentUsd":0,"calls":0}','{}')`.execute(owner);
    await sql`INSERT INTO hawa.design_studio_candidates(id,run_id,tenant_id,ordinal,concept,status,preview_png,preview_sha256)
      VALUES(${candidate}::uuid,${run}::uuid,${tenantId}::uuid,0,'{}','draft',${bytes},${sha})`.execute(owner);
    let send=await start();const body={runId:run,candidateId:candidate,previewSha256:sha,verdict:'revise',notes:'Increase heading spacing'};
    const post=()=>send(`/tasks/${task}/design-feedback`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});
    expect((await post()).status).toBe(201);
    const saved=(await sql<{actor_role:string;client_id:string}>`SELECT actor_role,client_id FROM hawa.design_feedback WHERE id=${key}::uuid`.execute(owner)).rows[0];
    expect(saved).toEqual({actor_role:'art_director',client_id:clientId});
    const history=await send(`/tasks/${task}/design-feedback`);expect(history.status).toBe(200);
    expect((await history.json()).feedback).toContainEqual(expect.objectContaining({id:key,actorRole:'art_director',clientId}));
    await stop('SIGKILL');send=await start();expect((await post()).status).toBe(200);
    await sql`INSERT INTO hawa.design_feedback(id,tenant_id,task_id,actor_id,source,verdict,notes)
      VALUES(${legacy}::uuid,${tenantId}::uuid,${task}::uuid,${actorId},'desk','revise','Legacy alignment instruction')`.execute(owner);
    const list=await send(`/clients/${clientId}/candidate-rules`),rules=(await list.json()).candidateRules;
    expect(rules.find((r:{provenance:{feedbackId:string}})=>r.provenance.feedbackId===key).provenance.actor.role).toBe('art_director');
    expect(rules.find((r:{provenance:{feedbackId:string}})=>r.provenance.feedbackId===legacy).provenance.actor.role).toBeUndefined();
    await expect(sql`UPDATE hawa.design_feedback SET notes='Changed source' WHERE id=${key}::uuid`.execute(owner)).rejects.toMatchObject({code:'55000'});
    await expect(sql`DELETE FROM hawa.design_feedback WHERE id=${key}::uuid`.execute(owner)).rejects.toMatchObject({code:'55000'});
    const instruction=randomUUID();
    expect((await send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers:{'Idempotency-Key':instruction},
      body:JSON.stringify({title:'Append-only instruction',category:'layout',ruleText:'Preserve recorded intent'})})).status).toBe(201);
    await expect(sql`UPDATE hawa.feedback_events SET category='changed' WHERE id=${instruction}::uuid`.execute(owner)).rejects.toMatchObject({code:'55000'});
    await expect(sql`DELETE FROM hawa.feedback_events WHERE id=${instruction}::uuid`.execute(owner)).rejects.toMatchObject({code:'55000'});
    await expect(withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>
      sql`UPDATE hawa.feedback_events SET comment='Runtime source edit' WHERE id=${instruction}::uuid`.execute(trx))).rejects.toMatchObject({code:'55000'});
    const outsider=randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${outsider}::uuid,${outsider+'@test.invalid'},'Foreign scope reader')`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES(${tenantId}::uuid,'c1000000-0000-4000-8000-000000000002'::uuid,${outsider}::uuid,'designer',true)`.execute(owner);
    const invisible=await withRlsContext(db,{tenantId,userId:outsider,role:'designer'},trx=>trx.selectFrom('design_feedback').select('id').where('task_id','=',task).execute());
    expect(invisible).toEqual([]);await stop();
  },30000);
  it('deduplicates legacy retries and preserves shared active text when one candidate retires',async()=>{
    const send=await start(),body={title:'Shared text A',category:'layout',ruleText:'Leave deliberate space around the subject'};
    const propose=(input:unknown)=>send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',body:JSON.stringify(input)});
    const first=await propose(body);expect(first.status).toBe(201);const a=(await first.json()).proposal;
    const retry=await propose(body);expect(retry.status).toBe(200);expect((await retry.json()).proposal.id).toBe(a.id);
    const second=await propose({...body,title:'Shared text B'});expect(second.status).toBe(201);const b=(await second.json()).proposal;
    const moderate=(id:string,action:string)=>send(`/clients/${clientId}/candidate-rules/${id}/${action}`,{method:'POST',body:'{}'});
    for(const rule of [a,b]) expect((await moderate(rule.id,'promote')).status).toBe(200);
    expect((await moderate(a.id,'rollback')).status).toBe(200);
    const dna=(await sql<{dna:{guidelines:{layoutRules:string[]}}}>`SELECT dna FROM hawa.client_dna_versions WHERE client_id=${clientId}::uuid AND status='active'`.execute(owner)).rows[0].dna;
    expect(dna.guidelines.layoutRules).toContain(b.ruleText);
    await stop('SIGKILL');const cold=await start();
    const list=await cold(`/clients/${clientId}/candidate-rules`);expect(list.status).toBe(200);
    expect((await list.json()).candidateRules).toContainEqual(expect.objectContaining({id:b.id,status:'PROMOTED'}));await stop();
  },30000);

  it('reconciles a committed source after an actual recovery query failure',async()=>{
    const send=await start(),key=randomUUID(),input={title:'Committed recovery retry',category:'layout',ruleText:'Recover committed intent after a read failure'};
    const post=()=>send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)});
    await sql.raw('REVOKE SELECT ON hawa.audit_events FROM hawa_app').execute(owner);
    try {
      expect((await post()).status).toBe(503);
      const stored=(await sql`SELECT id FROM hawa.feedback_events WHERE id=${key}::uuid`.execute(owner)).rows;
      expect(stored).toHaveLength(1);
    } finally {await sql.raw('GRANT SELECT ON hawa.audit_events TO hawa_app').execute(owner);}
    const retry=await post();expect(retry.status).toBe(200);const rule=(await retry.json()).proposal;
    expect(rule.id).toBe(`crule_${key}`);expect(rule.frequency).toBe(1);
    await stop();
  });
  it('serializes moderation in separate Core processes against current DNA',async()=>{
    const a=await start(),b=await start(),rules:{id:string;ruleText:string}[]=[];
    for(const [send,title] of [[a,'Process A rule'],[b,'Process B rule']] as const) {
      const response=await send(`/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers:{'Idempotency-Key':randomUUID()},
        body:JSON.stringify({title,category:'layout',ruleText:title})});expect(response.status).toBe(201);rules.push((await response.json()).proposal);
    }
    const moderate=(send:typeof a,index:number,action:string)=>send(`/clients/${clientId}/candidate-rules/${rules[index].id}/${action}`,{method:'POST',body:'{}'});
    for(const response of await Promise.all([moderate(a,0,'promote'),moderate(b,1,'promote')])) expect(response.status).toBe(200);
    let dna=(await sql<{dna:{guidelines:{layoutRules:string[]}}}>`SELECT dna FROM hawa.client_dna_versions WHERE client_id=${clientId}::uuid AND status='active'`.execute(owner)).rows[0].dna;
    expect(dna.guidelines.layoutRules).toEqual(expect.arrayContaining(rules.map(r=>r.ruleText)));
    for(const response of await Promise.all([moderate(a,0,'rollback'),moderate(b,1,'rollback')])) expect(response.status).toBe(200);
    dna=(await sql<{dna:{guidelines:{layoutRules:string[]}}}>`SELECT dna FROM hawa.client_dna_versions WHERE client_id=${clientId}::uuid AND status='active'`.execute(owner)).rows[0].dna;
    for(const rule of rules) expect(dna.guidelines.layoutRules).not.toContain(rule.ruleText);
    await stop('SIGKILL',a.process);await stop('SIGKILL',b.process);
  },30000);
  it('preserves a legacy moderation identity without inventing design approval',async()=>{
    const task=randomUUID(),legacySource=randomUUID();
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${task}::uuid,${tenantId}::uuid,${clientId}::uuid,'Historical moderation control')`.execute(owner);
    const miner=new FeedbackMiner(),rule=miner.proposeExplicitRule({clientId,taskId:task,title:'Legacy stored moderation',category:'layout',
      ruleText:'Historical scoped rule',rationale:'Synthetic legacy receipt',actor:{id:actorId,role:'art_director'}});
    // This historical receipt alone cannot prove a design approval.
    rule.examples.positiveExampleTaskIds=[task];
    const decision=planRuleModeration(rule,'dismiss',{id:actorId,role:'art_director'},'Historical dismissal',new Date().toISOString());
    await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>sql`
      INSERT INTO hawa.audit_events(tenant_id,client_id,actor_type,actor_id,action,resource_type,resource_id,data)
      VALUES(${tenantId}::uuid,${clientId}::uuid,'user',${actorId},'client_rule.dismissed','candidate_rule',${rule.id},
        ${JSON.stringify({proposal:decision.proposal,ruleRevision:1,moderation:{action:'dismiss',reason:'Historical dismissal',actorId,role:'art_director',auditHash:decision.auditHash}})}::jsonb)`.execute(trx));
    await sql`INSERT INTO hawa.feedback_events(id,tenant_id,client_id,task_id,category,scope,explicitness,target,actor_id)
      VALUES(${legacySource}::uuid,${tenantId}::uuid,${clientId}::uuid,${task}::uuid,'design_refinement','one_time','manual_edit','{}',${actorId})`.execute(owner);
    const send=await start();
    expect((await send(`/clients/${clientId}/negative-feedback`,{method:'POST',headers:{'Idempotency-Key':randomUUID()},
      body:JSON.stringify({taskId:task,feedbackText:'Current recorded rejection'})})).status).toBe(201);
    const list=await send(`/clients/${clientId}/candidate-rules`);expect(list.status).toBe(200);const body=await list.json();
    expect(body.excludedLegacySourceIds).toContain(legacySource);
    const recovered=body.candidateRules.find((r:{id:string})=>r.id===rule.id);
    expect(recovered).toMatchObject({id:rule.id,sha256Digest:rule.sha256Digest,status:'DISMISSED',moderationRevision:1});
    expect(recovered.examples.positiveExampleTaskIds).toEqual([]);expect(recovered.examples.negativeExampleTaskIds).toContain(task);
    const replay=await send(`/clients/${clientId}/candidate-rules/${rule.id}/dismiss`,{method:'POST',body:'{}'});
    expect(replay.status).toBe(200);expect((await replay.json()).replayed).toBe(true);await stop();
  });
  it('measures bounded local replay without a provider or a cache service',async()=>{
    const task=randomUUID();await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${task}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic recovery corpus')`.execute(owner);
    const ids=Array.from({length:500},()=>randomUUID());
    await sql`INSERT INTO hawa.design_feedback(id,tenant_id,client_id,task_id,actor_id,source,verdict,notes)
      SELECT id::uuid,${tenantId}::uuid,${clientId}::uuid,${task}::uuid,${actorId},'import','revise','Synthetic spacing instruction'
      FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS id`.execute(owner);
    const send=await start(),timings:number[]=[];
    for(let i=0;i<5;i++) {
      const begin=performance.now(),response=await send(`/clients/${clientId}/candidate-rules`);
      expect(response.status).toBe(200);const rules=(await response.json()).candidateRules;
      expect(rules.filter((r:{provenance:{taskId?:string}})=>r.provenance.taskId===task)).toHaveLength(500);
      timings.push(performance.now()-begin);
    }
    await writeFile('/tmp/hawa-learning-recovery-profile-20261001.json',JSON.stringify({syntheticSources:500,requests:5,milliseconds:timings,providerCalls:0},null,2));
    await stop();
  },30000);

});
