import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createDb,sql,withRlsContext} from '@hawa/db';
import type {ClientDNA} from '@hawa/domain';
import {createClientDnaResolver} from '../src/services/client-dna-resolver.js';
import {createAppWithClientFixtures} from './fixtures/app-with-client-fixtures.js';
import {activeDnaVersion,persistClientDnaFixture,clientDnaFixture} from './fixtures/persisted-client-dna.js';
import {approvedRefinementPair} from './fixtures/approved-refinement-pair.js';
import {memoryExportStore} from './pinned-exports-fixture.js';
import type {Publisher,PublishRequest} from '@hawa/contracts';
const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId='00000000-0000-4000-a000-000000000001';
const own='c1000000-0000-4000-8000-000000000003',foreign='c1000000-0000-4000-8000-000000000004';
const userId=randomUUID(),token=randomUUID();
const identity={tenantId,userId,role:'designer'};
const operator={tenantId,userId:'00000000-0000-4000-b000-000000000001',role:'operator'};
const headers={Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`,'Content-Type':'application/json'};
const app=createAppWithClientFixtures({db,extraBearerTokens:{[token]:{role:'designer',sub:userId}}});
const cached={clientId:foreign,name:'Private stale client',version:99} as ClientDNA;
const resolver=createClientDnaResolver({db,clientDnas:new Map([[foreign,cached],['client-fastpay',cached]])});
beforeAll(async()=>{
 await persistClientDnaFixture(app,own,headers);
 await persistClientDnaFixture(app,foreign,headers);
 await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@test.invalid'},'Scoped DNA reader')`.execute(owner);
 // ADR224 requires active office admission as well as the narrower client grant.
 await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'designer')`.execute(owner);
 await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
  VALUES(${tenantId}::uuid,${own}::uuid,${userId}::uuid,'designer',true)`.execute(owner);
 await (app as unknown as {clientDnaHydrated:Promise<number>}).clientDnaHydrated;
});
afterAll(async()=>{await db.destroy();await owner.destroy();});
describe('authoritative Client DNA boundary',()=>{
 it('does not recover denied UUIDs or aliases from a warmed privileged map',async()=>{
  expect(await resolver(foreign,identity)).toBeUndefined();
  expect(await resolver('client-fastpay',identity)).toBeUndefined();
  for(const client of [foreign,'fastpay','client-fastpay']) {
   expect((await app.request(`/v1/clients/${client}/dna`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(404);
  }
  expect((await app.request(`/v1/clients/${own}/dna`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(200);
 });
 it('requires explicit database identity rather than impersonating the default operator',async()=>{
  await expect(resolver(foreign)).rejects.toThrow();
 });
 it('keeps task consumers under the caller scope before evaluating or dispatching',async()=>{
  const created=await app.request('/v1/tasks',{method:'POST',headers,body:JSON.stringify({title:'[TEST] Private client brief',clientId:foreign})});
  expect(created.status).toBe(201);const task=await created.json();
  for(const path of [`/tasks/${task.id}/revisions/${randomUUID()}/evaluate-rubric`,
   `/campaigns/${task.id}/dispatch-review`,`/tasks/${task.id}/publish-omnichannel`,`/tasks/${task.id}/publish`]) {
   const response=await app.request(`/v1${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({phone:'+000000000',nodes:[{id:'t',type:'text',text:'Private brief'}]})});
   expect(response.status).toBe(404);
  }
 });
 it('refuses a real SQL read failure instead of answering from memory',async()=>{
  await sql.raw('REVOKE SELECT ON hawa.client_dna_versions FROM hawa_app').execute(owner);
  try {
   await expect(resolver(foreign,operator)).rejects.toThrow();
   const read=await app.request(`/v1/clients/${foreign}/dna`,{headers});
   expect(read.status).toBe(503);
   expect(JSON.stringify(await read.json())).not.toContain('permission denied');
  } finally {await sql.raw('GRANT SELECT ON hawa.client_dna_versions TO hawa_app').execute(owner);}
 });
 it('uses the row scope and version rather than conflicting JSON fields',async()=>{
  await sql`UPDATE hawa.client_dna_versions SET dna=jsonb_set(jsonb_set(jsonb_set(dna,'{clientId}',to_jsonb('client-spoofed'::text)),'{tenantId}',to_jsonb('tenant-spoofed'::text)),'{version}','900'::jsonb)
   WHERE tenant_id=${tenantId}::uuid AND client_id=${foreign}::uuid AND status='active'`.execute(owner);
  const current=await withRlsContext(db,operator,trx=>trx.selectFrom('client_dna_versions').select('version').where('client_id','=',foreign).where('status','=','active').executeTakeFirstOrThrow());
  expect(await resolver('client-fastpay',operator)).toMatchObject({clientId:foreign,tenantId,version:current.version});
 });
 it('uses the process store only when no database is configured',async()=>{
  const local=createClientDnaResolver({db:null,clientDnas:new Map([[foreign,cached]])});
  expect(await local(foreign)).toBe(cached);
 });
 it('does not activate a DNA update whose actual database commit fails',async()=>{
  const before=await resolver(foreign,operator);
  await sql.raw(`CREATE FUNCTION hawa.test_abort_dna_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.client_id='${foreign}'::uuid THEN RAISE EXCEPTION 'Synthetic DNA commit refusal'; END IF; RETURN NEW; END $$`).execute(owner);
  await sql.raw('CREATE CONSTRAINT TRIGGER test_abort_dna_commit AFTER INSERT ON hawa.client_dna_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hawa.test_abort_dna_commit()').execute(owner);
  try {
   const body={...clientDnaFixture(foreign),name:'Must never activate',expectedVersion:before!.version};
   const saved=await app.request(`/v1/clients/${foreign}/dna`,{method:'POST',headers,body:JSON.stringify(body)});
   expect(saved.status).toBe(500);
   expect(await resolver(foreign,operator)).toEqual(before);
  } finally {
   await sql.raw('DROP TRIGGER test_abort_dna_commit ON hawa.client_dna_versions').execute(owner);
   await sql.raw('DROP FUNCTION hawa.test_abort_dna_commit()').execute(owner);
  }
 });
 it('does not publish from cached DNA when the current source is unreadable',async()=>{
  const exports=memoryExportStore();
  const refused=async()=>({ok:false as const,error:{code:'CREDENTIALS_MISSING',message:'Explicit fixture has no provider',retryable:false,safeAction:'Connect the office Google account'}});
  const publisher:Publisher={publish:vi.fn(refused),reconcile:refused,verify:refused};
  const core=createAppWithClientFixtures({db,deliverableStore:exports.store,publisher});
  await persistClientDnaFixture(core,foreign,headers);
  const pair=await approvedRefinementPair(core,headers,foreign,exports);
  await sql.raw('REVOKE SELECT ON hawa.client_dna_versions FROM hawa_app').execute(owner);
  try {
   const response=await core.request(`/v1/tasks/${pair.taskId}/publish-omnichannel`,{method:'POST',headers,body:'{}'});
   expect(response.status).toBe(503);
   expect(publisher.publish).not.toHaveBeenCalled();
   const intent=await sql`SELECT id FROM hawa.publications WHERE task_id=${pair.taskId}::uuid`.execute(owner);
   expect(intent.rows).toHaveLength(0);
  } finally {await sql.raw('GRANT SELECT ON hawa.client_dna_versions TO hawa_app').execute(owner);}
 });
 it('replays frozen names and destinations after DNA changes and a real DNA read failure',async()=>{
  const exports=memoryExportStore(),requests:PublishRequest[]=[];
  const refused=async()=>({ok:false as const,error:{code:'CREDENTIALS_MISSING',message:'Explicit fixture has no provider',retryable:false,safeAction:'Connect the office Google account'}});
  const publisher:Publisher={publish:vi.fn(async(_ctx,request)=>{requests.push(request);return refused();}),reconcile:refused,verify:refused};
  const first=createAppWithClientFixtures({db,deliverableStore:exports.store,publisher});
  await persistClientDnaFixture(first,foreign,headers);
  const pair=await approvedRefinementPair(first,headers,foreign,exports);
  const publish=(core:typeof first)=>core.request(`/v1/tasks/${pair.taskId}/publish-omnichannel`,{method:'POST',headers,body:'{}'});
  expect((await publish(first)).status).toBe(422);expect(requests).toHaveLength(1);
  const dna=await persistClientDnaFixture(first,foreign,headers);
  const changed=await first.request(`/v1/clients/${foreign}/dna`,{method:'POST',headers,body:JSON.stringify({...dna,expectedVersion:await activeDnaVersion(first,foreign,headers),
   name:'Renamed office',destinations:{...dna.destinations,productionFolderId:'new-folder',spreadsheetId:'new-sheet',sheetId:17}})});
  expect(changed.status).toBe(201);
  const second=createAppWithClientFixtures({db,deliverableStore:exports.store,publisher});
  await (second as unknown as {clientDnaHydrated:Promise<number>}).clientDnaHydrated;
  await sql.raw('REVOKE SELECT ON hawa.client_dna_versions FROM hawa_app').execute(owner);
  try {
   const retry=await publish(second);expect(retry.status,JSON.stringify(await retry.json())).toBe(503);expect(requests).toHaveLength(2);
   expect(requests[1].destination).toEqual(requests[0].destination);
   expect(requests[1].files).toEqual(requests[0].files);
   expect(requests[1].sheetRow).toEqual(requests[0].sheetRow);
  } finally {await sql.raw('GRANT SELECT ON hawa.client_dna_versions TO hawa_app').execute(owner);}
 });
 it('returns actual completed Drive and Sheet links without reading current DNA or republishing',async()=>{
  const exports=memoryExportStore();
  const core=createAppWithClientFixtures({db,deliverableStore:exports.store});
  await persistClientDnaFixture(core,foreign,headers);
  const pair=await approvedRefinementPair(core,headers,foreign,exports);
  const publish=()=>core.request(`/v1/tasks/${pair.taskId}/publish-omnichannel`,{method:'POST',headers,body:'{}'});
  const sent=await publish();expect(sent.status).toBe(200);const original=await sent.json();
  const receipt=await sql<{folder_id:string;spreadsheet_id:string;sheet_id:number;row_number:number}>`
   SELECT d.folder_id,s.spreadsheet_id,s.sheet_id,s.row_number FROM hawa.publications p
   JOIN hawa.drive_refs d ON d.publication_id=p.id JOIN hawa.sheet_syncs s ON s.publication_id=p.id
   WHERE p.task_id=${pair.taskId}::uuid AND d.status='verified' AND s.status='synced'`.execute(owner);
  expect(receipt.rows.length).toBeGreaterThan(0);
  await sql.raw('REVOKE SELECT ON hawa.client_dna_versions FROM hawa_app').execute(owner);
  try {
   const replay=await publish();expect(replay.status).toBe(200);const answer=await replay.json();
   const actual=receipt.rows[0];
   expect(answer.alreadyCompleted).toBe(true);
   expect(answer.driveFolderUrl).toBe(`https://drive.google.com/drive/folders/${actual.folder_id}`);
   expect(answer.sheetRowUrl).toBe(`https://docs.google.com/spreadsheets/d/${actual.spreadsheet_id}#gid=${actual.sheet_id}&range=A${actual.row_number}`);
   expect(answer.publicationReceipt.publicationId).toBe(original.publicationReceipt.publicationId);
  } finally {await sql.raw('GRANT SELECT ON hawa.client_dna_versions TO hawa_app').execute(owner);}
 });
 it('allows the first configured Sheet while retaining frozen Drive and files',async()=>{
  const exports=memoryExportStore(),requests:PublishRequest[]=[];
  const refused=async()=>({ok:false as const,error:{code:'CREDENTIALS_MISSING',message:'Explicit fixture has no provider',retryable:false,safeAction:'Connect Google'}});
  const publisher:Publisher={publish:async(_ctx,request)=>{requests.push(request);return refused();},reconcile:refused,verify:refused};
  const core=createAppWithClientFixtures({db,deliverableStore:exports.store,publisher});
  const dna=await persistClientDnaFixture(core,foreign,headers);
  expect((await core.request(`/v1/clients/${foreign}/dna`,{method:'POST',headers,
   body:JSON.stringify({...dna,expectedVersion:await activeDnaVersion(core,foreign,headers),destinations:{...dna.destinations,spreadsheetId:'',sheetId:0}})})).status).toBe(201);
  const pair=await approvedRefinementPair(core,headers,foreign,exports);
  const publish=()=>core.request(`/v1/tasks/${pair.taskId}/publish-omnichannel`,{method:'POST',headers,body:'{}'});
  expect((await publish()).status).toBe(422);expect(requests).toHaveLength(1);
  expect((await core.request(`/v1/clients/${foreign}/dna`,{method:'POST',headers,
   body:JSON.stringify({...dna,expectedVersion:await activeDnaVersion(core,foreign,headers),name:'New identity',destinations:{...dna.destinations,productionFolderId:'new-drive',spreadsheetId:'first-sheet',sheetId:19}})})).status).toBe(201);
  expect((await publish()).status).toBe(503);expect(requests).toHaveLength(2);
  expect(requests[1].destination).toEqual({...requests[0].destination,spreadsheetId:'first-sheet',sheetId:19});
  expect(requests[1].files).toEqual(requests[0].files);
 });
});
