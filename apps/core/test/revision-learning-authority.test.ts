import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createDb,sql} from '@hawa/db';
import {createAppWithClientFixtures} from './fixtures/app-with-client-fixtures.js';
import {approvedRefinementPair} from './fixtures/approved-refinement-pair.js';
import {memoryExportStore} from './pinned-exports-fixture.js';
const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const clientId='c1000000-0000-4000-8000-000000000003',tenantId='00000000-0000-4000-a000-000000000001';
const headers={'Content-Type':'application/json',Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`};
const exports=memoryExportStore(),app=createAppWithClientFixtures({db,deliverableStore:exports.store});
afterAll(async()=>{await db.destroy();await owner.destroy();});
it('verifies native approval authority, excludes unattested history and refuses changed new source hashes',async()=>{
  const pair=await approvedRefinementPair(app,headers,clientId,exports);
  const mine=await app.request('/v1/feedback/mine',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify(pair)});
  expect(mine.status).toBe(201);
  const get=()=>app.request(`/v1/clients/${clientId}/candidate-rules`,{headers});
  const valid=await get();expect(valid.status).toBe(200);
  const rule=(await valid.json()).candidateRules.find((r:{refinementEvidence?:{taskId:string}[]})=>r.refinementEvidence?.some(e=>e.taskId===pair.taskId));
  expect(rule.examples.positiveExamples).toContainEqual(expect.objectContaining({basis:'revision_decision',target:expect.objectContaining({revisionId:pair.afterRevisionId})}));
  const foreign=await approvedRefinementPair(app,headers,clientId,exports);
  const wrongRevision=await app.request(`/v1/clients/${clientId}/negative-feedback`,{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},
    body:JSON.stringify({taskId:pair.taskId,revisionId:foreign.afterRevisionId,feedbackText:'Foreign task revision control'})});
  expect(wrongRevision.status).toBe(409);
  const legacy=randomUUID();
  await sql`INSERT INTO hawa.feedback_events(id,tenant_id,client_id,task_id,category,explicitness,target,actor_id)
    VALUES(${legacy}::uuid,${tenantId}::uuid,${clientId}::uuid,${pair.taskId}::uuid,'decision.approved','approval_signal',
      ${JSON.stringify({revisionId:pair.afterRevisionId,approvalId:randomUUID(),decision:'approved'})}::jsonb,'00000000-0000-4000-b000-000000000002'::uuid)`.execute(owner);
  const historical=await get();expect(historical.status).toBe(200);expect((await historical.json()).excludedLegacySourceIds).toContain(legacy);
  const source=(await sql<{target:Record<string,unknown>;actor_id:string}>`SELECT target,actor_id FROM hawa.feedback_events
    WHERE task_id=${pair.taskId}::uuid AND category='decision.approved' AND id<>${legacy}::uuid`.execute(owner)).rows[0];
  await sql`INSERT INTO hawa.feedback_events(id,tenant_id,client_id,task_id,category,explicitness,target,actor_id)
    VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${clientId}::uuid,${pair.taskId}::uuid,'decision.approved','approval_signal',
      ${JSON.stringify({...source.target,sourceSha256:'f'.repeat(64)})}::jsonb,${source.actor_id}::uuid)`.execute(owner);
  expect((await get()).status).toBe(503);
});
