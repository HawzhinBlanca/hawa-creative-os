import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { globalFeedbackMiner } from '@hawa/creative';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { approvedRefinementPair } from './fixtures/approved-refinement-pair.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

const db=createDb(process.env.TEST_DATABASE_URL!);
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const exports=memoryExportStore();
const app=createAppWithClientFixtures({db,deliverableStore:exports.store});
const headers={'Content-Type':'application/json',Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`};
const tenantId='00000000-0000-4000-a000-000000000001',actorId='00000000-0000-4000-b000-000000000002';
const clientId='c1000000-0000-4000-8000-000000000003';
let pair:Awaited<ReturnType<typeof approvedRefinementPair>>;
const post=(body:unknown,key=randomUUID())=>app.request('/v1/feedback/mine',{method:'POST',headers:{...headers,'Idempotency-Key':key},body:JSON.stringify(body)});
afterAll(async()=>{await db.destroy();await owner.destroy();});
beforeAll(async()=>{pair=await approvedRefinementPair(app,headers,clientId,exports);});

describe('Approved revision learning authority',()=>{
  it('persists real source/approval/actor lineage and reconciles exact retries',async()=>{
    const actionId=randomUUID(),response=await post(pair,actionId);
    expect(response.status).toBe(201);
    const body=await response.json();expect(body.count).toBeGreaterThan(0);
    const rule=body.proposedRules[0];
    expect(rule.refinementEvidence[0]).toMatchObject({...pair,feedbackId:actionId,actor:{id:actorId,role:'art_director'}});
    const stored=await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>trx.selectFrom('feedback_events').selectAll().where('id','=',actionId).executeTakeFirstOrThrow());
    expect(stored.before_revision_id).toBe(pair.beforeRevisionId);expect(stored.after_revision_id).toBe(pair.afterRevisionId);
    expect(stored.actor_id).toBe(actorId);expect(stored.explicitness).toBe('manual_edit');
    const replay=await post(pair,actionId);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,count:0});
    expect(globalFeedbackMiner.getCandidateRules(clientId).find(r=>r.id===rule.id)?.frequency).toBe(1);
    const freshKey=await post(pair);expect(freshKey.status).toBe(201);
    expect(globalFeedbackMiner.getCandidateRules(clientId).find(r=>r.id===rule.id)?.frequency).toBe(1);
  });
  it('refuses supplied artboards, nonexistent/cross-task/client and unordered evidence',async()=>{
    for(const [body,status] of [
      [{...pair,initialArtboard:{nodes:[]},finalArtboard:{nodes:[]}},422],
      [{...pair,taskId:randomUUID()},404],
      [{...pair,clientId:'c1000000-0000-4000-8000-000000000002'},409],
      [{...pair,beforeRevisionId:randomUUID()},409],
      [{...pair,beforeRevisionId:pair.afterRevisionId},409],
      [{...pair,afterRevisionId:pair.beforeRevisionId,beforeRevisionId:pair.afterRevisionId},409],
    ] as const) expect((await post(body)).status).toBe(status);
  });
  it('rejects a task that has no actual final approval',async()=>{
    const task=randomUUID(),doc=randomUUID(),before=randomUUID(),after=randomUUID();
    await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},async trx=>{
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state) VALUES(${task}::uuid,${tenantId}::uuid,${clientId}::uuid,'Unapproved edit','received')`.execute(trx);
      await sql`INSERT INTO hawa.design_documents(id,tenant_id,task_id,studio) VALUES(${doc}::uuid,${tenantId}::uuid,${task}::uuid,'canva')`.execute(trx);
      for(const [id,number] of [[before,1],[after,2]] as const) {
        await sql`INSERT INTO hawa.design_revisions(id,tenant_id,task_id,design_document_id,revision,studio,studio_version,studio_schema_version,source_storage_key,source_sha256,neutral_manifest,neutral_manifest_sha256,semantic_hash,author_type,status)
          VALUES(${id}::uuid,${tenantId}::uuid,${task}::uuid,${doc}::uuid,${number},'canva','test','test','fixture',${'a'.repeat(64)},'{"nodes":[]}',${'a'.repeat(64)},${'a'.repeat(64)},'user','review')`.execute(trx);
      }
      await trx.updateTable('tasks').set({current_design_revision_id:after}).where('id','=',task).execute();
    });
    const response=await post({taskId:task,clientId,beforeRevisionId:before,afterRevisionId:after});
    expect(response.status).toBe(409);expect((await response.json()).title).toBe('APPROVED_REFINEMENT_REQUIRED');
  });
  it('keeps promotion lineage in one immutable audit and reconciles concurrent promotion',async()=>{
    const response=await post(pair);expect(response.status).toBe(201);
    const rule=globalFeedbackMiner.getCandidateRules(clientId).find(r=>r.refinementEvidence?.some(e=>e.taskId===pair.taskId))!;
    const promote=()=>app.request(`/v1/clients/${clientId}/candidate-rules/${rule.id}/promote`,{method:'POST',headers});
    const results=await Promise.all([promote(),promote()]);
    for(const result of results) expect(result.status).toBe(200);
    const audits=await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>sql<{data:{proposal:{refinementEvidence:unknown[]};dnaVersionId:string}}> `
      SELECT data FROM hawa.audit_events WHERE tenant_id=${tenantId}::uuid AND resource_id=${rule.id} AND action='client_rule.promoted'`.execute(trx));
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].data.proposal.refinementEvidence).toEqual(rule.refinementEvidence);
    expect(audits.rows[0].data.dnaVersionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await promote()).status).toBe(200);
  });
  it('keeps a failed promotion out of both active DNA and process-local state',async()=>{
    const proposed=await app.request(`/v1/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers,
      body:JSON.stringify({title:'Atomic instruction',category:'layout',ruleText:'Keep approved source lineage during promotion',rationale:'Isolated rollback control'})});
    expect(proposed.status).toBe(201);const rule=(await proposed.json()).proposal;
    expect(rule.provenance.taskId).toBeUndefined();expect(rule.examples.positiveExampleTaskIds).toEqual([]);
    const before=await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>trx.selectFrom('client_dna_versions')
      .select('id').where('client_id','=',clientId).execute());
    await sql.raw(`CREATE FUNCTION hawa.test_rule_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected rule audit failure'; END $$`).execute(owner);
    await sql.raw(`CREATE TRIGGER test_rule_audit_failure BEFORE INSERT ON hawa.audit_events FOR EACH ROW
      WHEN (NEW.action='client_rule.promoted') EXECUTE FUNCTION hawa.test_rule_audit_failure()`).execute(owner);
    try {
      const response=await app.request(`/v1/clients/${clientId}/candidate-rules/${rule.id}/promote`,{method:'POST',headers});
      expect(response.status).toBe(500);
      const local=globalFeedbackMiner.getCandidateRules(clientId).find(r=>r.id===rule.id)!;
      expect(local.status).toBe('PROPOSED');expect(local.promotedByRole).toBeUndefined();expect(local.promotedAt).toBeUndefined();
      const after=await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>trx.selectFrom('client_dna_versions')
        .select('id').where('client_id','=',clientId).execute());
      expect(after).toEqual(before);
    } finally {await sql.raw('DROP FUNCTION hawa.test_rule_audit_failure() CASCADE').execute(owner);}
  });
  it('preserves both independently promoted rules and replays after later DNA versions',async()=>{
    const rules:{id:string;ruleText:string}[]=[];
    for(const word of ['First','Second']) {
      const response=await app.request(`/v1/clients/${clientId}/candidate-rules/propose`,{method:'POST',headers,
        body:JSON.stringify({title:`${word} instruction`,category:'layout',ruleText:`${word} isolated approved instruction`})});
      expect(response.status).toBe(201);rules.push((await response.json()).proposal);
    }
    const promote=(id:string)=>app.request(`/v1/clients/${clientId}/candidate-rules/${id}/promote`,{method:'POST',headers});
    for(const response of await Promise.all(rules.map(rule=>promote(rule.id)))) expect(response.status).toBe(200);
    const active=await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>trx.selectFrom('client_dna_versions')
      .selectAll().where('client_id','=',clientId).where('status','=','active').executeTakeFirstOrThrow());
    expect(active.dna).toMatchObject({guidelines:{layoutRules:expect.arrayContaining(rules.map(rule=>rule.ruleText))}});
    const replay=await promote(rules[0].id);expect(replay.status).toBe(200);expect((await replay.json()).replayed).toBe(true);
    const audits=await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},trx=>sql`
      SELECT id FROM hawa.audit_events WHERE action='client_rule.promoted' AND resource_id=${rules[0].id}`.execute(trx));
    expect(audits.rows).toHaveLength(1);
  });
  it('hides client-wide promotion audits from foreign scope and refuses forged attribution',async()=>{
    const scope={tenantId,clientId,userId:actorId,role:'art_director'};
    const foreign=await withRlsContext(db,{...scope,tenantId:'00000000-0000-4000-a000-000000000005'},trx=>sql`
      SELECT id FROM hawa.audit_events WHERE action='client_rule.promoted' AND client_id=${clientId}::uuid`.execute(trx));
    expect(foreign.rows).toHaveLength(0);
    await expect(withRlsContext(db,scope,trx=>sql`INSERT INTO hawa.audit_events(tenant_id,client_id,actor_type,actor_id,action,resource_type,resource_id)
      VALUES(${tenantId}::uuid,${clientId}::uuid,'user','forged_actor','client_rule.promoted','candidate_rule','forged_rule')`.execute(trx)))
      .rejects.toMatchObject({code:'42501'});
    const outsider=randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${outsider}::uuid,${`${outsider}@test.invalid`},'Scoped viewer')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES(${tenantId}::uuid,${outsider}::uuid,'requester',true)`.execute(owner);
    const invisible=await withRlsContext(db,{...scope,userId:outsider,role:'requester'},trx=>sql`
      SELECT id FROM hawa.audit_events WHERE action='client_rule.promoted' AND client_id=${clientId}::uuid`.execute(trx));
    expect(invisible.rows).toHaveLength(0);
    await expect(withRlsContext(db,{...scope,userId:outsider,role:'requester'},trx=>sql`
      INSERT INTO hawa.audit_events(tenant_id,client_id,actor_type,actor_id,action,resource_type,resource_id)
      VALUES(${tenantId}::uuid,${clientId}::uuid,'user',${outsider},'client_rule.promoted','candidate_rule','foreign_client')`.execute(trx)))
      .rejects.toMatchObject({code:'42501'});
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES(${tenantId}::uuid,${clientId}::uuid,${outsider}::uuid,'requester',true)`.execute(owner);
    const visible=await withRlsContext(db,{...scope,userId:outsider,role:'requester'},trx=>sql`
      SELECT id FROM hawa.audit_events WHERE action='client_rule.promoted' AND client_id=${clientId}::uuid`.execute(trx));
    expect(visible.rows.length).toBeGreaterThan(0);
    await expect(withRlsContext(db,{...scope,userId:outsider,role:'requester'},trx=>sql`
      INSERT INTO hawa.audit_events(tenant_id,client_id,actor_type,actor_id,action,resource_type,resource_id)
      VALUES(${tenantId}::uuid,${clientId}::uuid,'user',${outsider},'client_rule.promoted','candidate_rule','read_only_member')`.execute(trx)))
      .rejects.toMatchObject({code:'42501'});
  });
  it('refuses learning after a later failing QA attempt replaces the approved evidence',async()=>{
    await withRlsContext(db,{tenantId,clientId,userId:actorId,role:'art_director'},async trx=>{
      const previous=await trx.selectFrom('qc_runs').selectAll().where('design_revision_id','=',pair.afterRevisionId).executeTakeFirstOrThrow();
      await trx.insertInto('qc_runs').values({tenant_id:tenantId,task_id:pair.taskId,design_revision_id:pair.afterRevisionId,
        qc_profile_id:previous.qc_profile_id,attempt:previous.attempt+1,status:'failed',critical_pass:false,report:{control:'later failure'},
        report_sha256:'f'.repeat(64),trace_id:null,started_at:new Date(Date.now()+1000),completed_at:new Date()}).execute();
    });
    const response=await post(pair);expect(response.status).toBe(409);
    expect((await response.json()).title).toBe('REFINEMENT_SOURCE_EVIDENCE_CHANGED');
  });
});
