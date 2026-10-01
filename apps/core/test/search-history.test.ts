import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { deskReviewTarget } from '@hawa/contracts/desk-navigation';
const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenant = '00000000-0000-4000-a000-000000000001';
const client = randomUUID(), peer = randomUUID(), task = randomUUID(), peerTask = randomUUID(), revision = randomUUID();
const event = randomUUID(), studioEvent = randomUUID(), designer = randomUUID();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const app = () => createApp({ db, testAuth: { principal: { role: 'operator' } } });
async function search(q: string, category: string, clientId: string = client, instance = app()) {
  const response = await instance.request(`/v1/search?${new URLSearchParams({q,category,clientId})}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{results: Array<{id:string;category:string;title:string;subtitle:string;url:string|null}>;hits:Array<{item:{metadata:Record<string,unknown>;bodyText:string}}> ;truncated:boolean}>;
}
afterAll(async () => { await db.destroy(); await owner.destroy(); });
afterEach(() => vi.unstubAllEnvs());
beforeAll(async () => {
  for (const [id,name] of [[client,'Newclientidentity'],[peer,'Otherclientidentity']]) {
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${id}::uuid,${tenant}::uuid,${'history-'+id},${name})`.execute(owner);
  }
  for (const [id,clientId] of [[task,client],[peerTask,peer]]) {
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${id}::uuid,${tenant}::uuid,${clientId}::uuid,'Generic request')`.execute(owner);
  }
  const peerDocument=randomUUID(),peerRevision=randomUUID(),peerManifest={title:'Peerhistoryneedle',nodes:[{type:'text',text:'Peerhistoryneedle'}]};
  await sql`INSERT INTO hawa.design_documents(id,tenant_id,task_id,studio) VALUES(${peerDocument}::uuid,${tenant}::uuid,${peerTask}::uuid,'canva')`.execute(owner);
  await sql`INSERT INTO hawa.design_revisions(id,tenant_id,task_id,design_document_id,revision,studio,studio_version,studio_schema_version,
    source_storage_key,source_sha256,neutral_manifest,neutral_manifest_sha256,semantic_hash,author_type,status)
    VALUES(${peerRevision}::uuid,${tenant}::uuid,${peerTask}::uuid,${peerDocument}::uuid,1,'canva','fixture','fixture','fixture',${digest(peerRevision)},
      ${JSON.stringify(peerManifest)}::jsonb,${digest(JSON.stringify(peerManifest))},'fixture','user','review')`.execute(owner);
  await sql`INSERT INTO hawa.feedback_events(tenant_id,client_id,task_id,category,explicitness,comment)
    VALUES(${tenant}::uuid,${peer}::uuid,${peerTask}::uuid,'copy','direct_instruction','Peerhistoryneedle')`.execute(owner);
  const document = randomUUID();
  await sql`INSERT INTO hawa.design_documents(id,tenant_id,task_id,studio) VALUES(${document}::uuid,${tenant}::uuid,${task}::uuid,'canva')`.execute(owner);
  const manifest = {title:'Historicrevisionneedle',nodes:[{id:'title',type:'text',text:'Historiccopyneedle كردي ١٢٣'}],
    copy:['Nativecopyneedle', {credential:'DoNotIndexNestedCopy'}], transportHint:'NeverIndexInternalManifest'};
  await sql`INSERT INTO hawa.design_revisions(id,tenant_id,task_id,design_document_id,revision,studio,studio_version,studio_schema_version,
    source_storage_key,source_sha256,neutral_manifest,neutral_manifest_sha256,semantic_hash,author_type,status)
    VALUES(${revision}::uuid,${tenant}::uuid,${task}::uuid,${document}::uuid,1,'canva','fixture','fixture','fixture',${digest(revision)},
      ${JSON.stringify(manifest)}::jsonb,${digest(JSON.stringify(manifest))},'fixture','user','review')`.execute(owner);
  await sql`INSERT INTO hawa.feedback_events(id,tenant_id,client_id,task_id,before_revision_id,category,explicitness,comment)
    VALUES(${event}::uuid,${tenant}::uuid,${client}::uuid,${task}::uuid,${revision}::uuid,'copy','direct_instruction','Historicalfeedbackneedle exact note')`.execute(owner);
  await sql`INSERT INTO hawa.design_feedback(id,tenant_id,client_id,task_id,actor_id,source,verdict,notes)
    VALUES(${studioEvent}::uuid,${tenant}::uuid,${client}::uuid,${task}::uuid,'fixture','desk','revise','Studiocorrectionneedle exact note')`.execute(owner);
  await sql`INSERT INTO hawa.feedback_events(tenant_id,client_id,task_id,category,explicitness,comment)
    VALUES(${tenant}::uuid,${client}::uuid,${peerTask}::uuid,'copy','direct_instruction','Contradictoryscopeforbidden')`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${designer}::uuid,${designer+'@example.test'},'History designer')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${designer}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenant}::uuid,${client}::uuid,${designer}::uuid,'designer')`.execute(owner);
});
it('finds a registered client before any DNA exists, including its code alias',async()=>{
  expect((await search('Newclientidentity','clients')).results.map(r=>r.id)).toContain(client);
  expect((await search('Newclientidentity','clients','history-'+client)).results.map(r=>r.id)).toContain(client);
});
it('finds ledger feedback after a cold Core start and opens its actual revision',async()=>{
  const result=await search('Historicalfeedbackneedle','feedback');
  expect(result.results).toHaveLength(1);
  expect(result.results[0].subtitle).toContain('exact note');
  expect(deskReviewTarget(result.results[0].url!)).toEqual({taskId:task,revisionId:revision});
});
it('finds Studio feedback with its retained verdict and task navigation',async()=>{
  const result=await search('Studiocorrectionneedle','feedback');
  expect(result.results).toHaveLength(1);
  expect(result.results[0].subtitle).toContain('exact note');
  expect(deskReviewTarget(result.results[0].url!)).toEqual({taskId:task});
});
it('finds the historical revision independently of the current task title',async()=>{
  const result=await search('Historicrevisionneedle','revisions');
  expect(result.results.map(r=>r.id)).toContain(revision);
  expect(deskReviewTarget(result.results.find(r=>r.id===revision)!.url!)).toEqual({taskId:task,revisionId:revision});
});
it('finds exact node and native-manifest copy in its own category without indexing arbitrary JSON',async()=>{
  for(const query of ['Historiccopyneedle','کردی 123','Nativecopyneedle']) {
    const result=await search(query,'copy');expect(result.results).toHaveLength(1);
    expect(deskReviewTarget(result.results[0].url!)).toEqual({taskId:task,revisionId:revision});
  }
  for(const query of ['NeverIndexInternalManifest','DoNotIndexNestedCopy']) expect((await search(query,'all')).results).toEqual([]);
});
it('never retrieves peer or contradictory source scope, including through client aliases and scoped designers',async()=>{
  const scoped=createApp({db,testAuth:{principal:{role:'designer',userId:designer}}});
  const office=await search('Peerhistoryneedle','all','all');
  expect(new Set(office.results.map(r=>r.category))).toEqual(new Set(['FEEDBACK','REVISIONS','COPY']));
  for (const category of ['feedback','revisions','copy']) expect((await search('Peerhistoryneedle',category,'all',scoped)).results).toEqual([]);
  for(const category of ['feedback','revisions','copy']) {
    const query=category==='feedback'?'Historicalfeedbackneedle':category==='revisions'?'Historicrevisionneedle':'Historiccopyneedle';
    expect((await search(query,category,peer)).results).toEqual([]);
    expect((await search(query,category,client,scoped)).results).toHaveLength(1);
    expect((await search(query,category,peer,scoped)).results).toEqual([]);
    expect((await search(query,category,'unknown-client')).results).toEqual([]);
  }
  expect((await search('Contradictoryscopeforbidden','feedback')).results).toEqual([]);
});
it('matches before its bounded history read rather than losing old relevant evidence',async()=>{
  await sql`INSERT INTO hawa.feedback_events(tenant_id,client_id,task_id,category,explicitness,comment,created_at)
    SELECT ${tenant}::uuid,${client}::uuid,${task}::uuid,'copy','direct_instruction','Newer irrelevant feedback',
      clock_timestamp()+g*interval '1 millisecond' FROM generate_series(1,20) g`.execute(owner);
  vi.stubEnv('HAWA_SEARCH_HISTORY_CEILING','2');
  const old=await search('Historicalfeedbackneedle','feedback');expect(old.results).toHaveLength(1);expect(old.truncated).toBe(false);
  const capped=await search('Newer irrelevant','feedback');expect(capped.results).toHaveLength(2);expect(capped.truncated).toBe(true);
});
it('refuses unsupported search categories before reading state',async()=>{
  const response=await app().request('/v1/search?q=anything&category=unrecognised');expect(response.status).toBe(400);
});

it('finds original request copy before any revision exists',async()=>{
  const intake=await persistChatIntake(db,{platform:'telegram',sourceEventId:randomUUID(),sourceChannelId:randomUUID(),
    clientId:client,title:'Generic copy request',rawText:'Original request',designInstructions:'Use supplied assets',exactCopy:['Originalrequestcopyneedle']});
  const result=await search('Originalrequestcopyneedle','copy');expect(result.results).toHaveLength(1);
  expect(deskReviewTarget(result.results[0].url!)).toEqual({taskId:intake.task.id});
  expect((await search('Originalrequestcopyneedle','copy',peer)).results).toEqual([]);
});
it('finds retained Studio copy without indexing the rest of its request',async()=>{
  const run=randomUUID();
  await sql`INSERT INTO hawa.design_studio_runs(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,tier,status)
    VALUES(${run}::uuid,${tenant}::uuid,${task}::uuid,${client}::uuid,'fixture',${run},${digest(run)},
      ${JSON.stringify({copyBlocks:[{text:'Studiosourcecopyneedle'}],privateTransport:'DoNotIndexTransport'})}::jsonb,'standard','briefing')`.execute(owner);
  const result=await search('Studiosourcecopyneedle','copy');expect(result.results).toHaveLength(1);
  expect(deskReviewTarget(result.results[0].url!)).toEqual({taskId:task});
  expect((await search('DoNotIndexTransport','all')).results).toEqual([]);
});
it('opens a taskless client note on that client rather than inventing a task',async()=>{
  await sql`INSERT INTO hawa.feedback_events(tenant_id,client_id,category,explicitness,comment)
    VALUES(${tenant}::uuid,${client}::uuid,'brand','direct_instruction','Tasklessclientnoteneedle')`.execute(owner);
  const result=await search('Tasklessclientnoteneedle','feedback');expect(result.results).toHaveLength(1);
  expect(result.results[0].url).toBe(`#/dna?client=${client}`);
});
it('excludes another tenant even when its comment matches an authorized office search',async()=>{
  const foreignTenant=randomUUID(),foreignClient=randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${foreignTenant}::uuid,'Foreign fixture',${foreignTenant})`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${foreignClient}::uuid,${foreignTenant}::uuid,${foreignClient},'Foreign fixture')`.execute(owner);
  await sql`INSERT INTO hawa.feedback_events(tenant_id,client_id,category,explicitness,comment)
    VALUES(${foreignTenant}::uuid,${foreignClient}::uuid,'brand','direct_instruction','OtherTenantCommentneedle')`.execute(owner);
  expect((await search('OtherTenantCommentneedle','feedback','all')).results).toEqual([]);
  expect((await search('OtherTenantCommentneedle','feedback',foreignClient)).results).toEqual([]);
});
it('makes stored read failures unavailable and never returns a warmed history result',async()=>{
  const instance=app();expect((await search('Historicalfeedbackneedle','feedback',client,instance)).results).toHaveLength(1);
  await sql.raw('REVOKE SELECT ON hawa.feedback_events FROM hawa_app').execute(owner);
  try {
    const response=await instance.request(`/v1/search?${new URLSearchParams({q:'Historicalfeedbackneedle',category:'feedback',clientId:client})}`);
    expect(response.status).toBe(503);expect((await response.json()).results).toBeUndefined();
  } finally {await sql.raw('GRANT SELECT ON hawa.feedback_events TO hawa_app').execute(owner);}
});
it('validates category before database access',async()=>{
  await sql.raw('REVOKE SELECT ON hawa.clients FROM hawa_app').execute(owner);
  try {expect((await app().request('/v1/search?q=anything&category=invalid')).status).toBe(400);}
  finally {await sql.raw('GRANT SELECT ON hawa.clients TO hawa_app').execute(owner);}
});

it('searches the retained wording of a real explicit brand instruction without exposing internal source metadata',async()=>{
  const response=await app().request(`/v1/clients/${client}/candidate-rules/propose`,{method:'POST',
    headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},
    body:JSON.stringify({title:'Instruction fixture',category:'typography',ruleText:'Explicitbrandinstructionneedle',rationale:'Operator direction'})});
  expect(response.status).toBe(201);
  const result=await search('Explicitbrandinstructionneedle','feedback');expect(result.results).toHaveLength(1);
  expect(result.results[0].url).toBe(`#/dna?client=${client}`);
});

it('does not present a copy record when a stored revision contains no factual text',async()=>{
  const blank=randomUUID(),manifest={nodes:[{type:'frame',text:{internal:'IgnoredMalformedText'}}],copy:{internal:'IgnoredMalformedCopy'}};
  await sql`INSERT INTO hawa.design_revisions(id,tenant_id,task_id,design_document_id,revision,studio,studio_version,studio_schema_version,
    source_storage_key,source_sha256,neutral_manifest,neutral_manifest_sha256,semantic_hash,author_type,status)
    SELECT ${blank}::uuid,tenant_id,task_id,design_document_id,2,studio,studio_version,studio_schema_version,'fixture',${digest(blank)},
      ${JSON.stringify(manifest)}::jsonb,${digest(JSON.stringify(manifest))},'fixture','user','draft'
    FROM hawa.design_revisions WHERE id=${revision}::uuid`.execute(owner);
  const result=await search('','copy');expect(result.hits.some(h=>h.item.metadata.revisionId===blank)).toBe(false);
  expect((await search('IgnoredMalformedText','all')).results).toEqual([]);
  expect((await search('IgnoredMalformedCopy','all')).results).toEqual([]);
});
