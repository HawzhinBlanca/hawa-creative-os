import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

const db=createDb(process.env.TEST_DATABASE_URL!);
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId='00000000-0000-4000-a000-000000000001',clientId='c1000000-0000-4000-8000-000000000003';
const app=createAppWithClientFixtures({db});
const headers={'Content-Type':'application/json',Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`};
afterAll(async()=>{await db.destroy();await owner.destroy();});
async function revision(){
  const created=await app.request('/v1/tasks',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},
    body:JSON.stringify({title:'Synthetic QA persistence',clientId})});
  expect(created.status).toBe(201);const task=await created.json() as {id:string};
  const saved=await app.request(`/v1/tasks/${task.id}/revisions`,{method:'POST',headers,
    body:JSON.stringify({nodes:[{id:'title',type:'text',text:'Recorded exact wording'}]})});
  expect(saved.status).toBe(201);const rev=await saved.json() as {id:string};
  return {taskId:task.id,revisionId:rev.id,path:`/v1/tasks/${task.id}/revisions/${rev.id}/qa`};
}
it('records successful revision QA under the actual current authenticated writer',async()=>{
  const r=await revision(),response=await app.request(r.path,{method:'POST',headers});
  expect(response.status).toBe(200);
  const runs=await sql<{task_id:string;design_revision_id:string}>`SELECT task_id,design_revision_id
    FROM hawa.qc_runs WHERE task_id=${r.taskId}::uuid AND design_revision_id=${r.revisionId}::uuid`.execute(owner);
  expect(runs.rows).toEqual([{task_id:r.taskId,design_revision_id:r.revisionId}]);
});
it('refuses successful HTTP QA when its real evidence write fails',async()=>{
  const r=await revision();
  await sql.raw(`CREATE FUNCTION hawa.synthetic_qa_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic QA write unavailable'; END $$;
    CREATE TRIGGER synthetic_qa_write_failure BEFORE INSERT ON hawa.qc_runs
    FOR EACH ROW EXECUTE FUNCTION hawa.synthetic_qa_write_failure();`).execute(owner);
  try {
    expect((await app.request(r.path,{method:'POST',headers})).status).toBe(503);
    expect((await sql`SELECT id FROM hawa.qc_runs WHERE design_revision_id=${r.revisionId}::uuid`.execute(owner)).rows).toEqual([]);
  } finally {
    await sql.raw('DROP TRIGGER synthetic_qa_write_failure ON hawa.qc_runs; DROP FUNCTION hawa.synthetic_qa_write_failure()').execute(owner);
  }
});
it('a read-only assigned reviewer cannot create QA records through a substituted service identity',async()=>{
  const r=await revision(),userId=randomUUID();
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic readonly reviewer')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'approver')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenantId}::uuid,${clientId}::uuid,${userId}::uuid,'approver')`.execute(owner);
  const reviewer=createAppWithClientFixtures({db,testAuth:{principal:{role:'approver',userId}}});
  expect((await reviewer.request(r.path,{method:'POST'})).status).toBe(403);
  expect((await sql`SELECT id FROM hawa.qc_runs WHERE design_revision_id=${r.revisionId}::uuid`.execute(owner)).rows).toEqual([]);
});

it('records concurrent legitimate reruns as separate ordered QA attempts',async()=>{
  const r=await revision();
  const responses=await Promise.all([1,2].map(()=>app.request(r.path,{method:'POST',headers})));
  expect(responses.map(r=>r.status)).toEqual([200,200]);
  const rows=await sql<{attempt:number}>`SELECT attempt FROM hawa.qc_runs
    WHERE design_revision_id=${r.revisionId}::uuid ORDER BY attempt`.execute(owner);
  expect(rows.rows.map(r=>r.attempt)).toEqual([1,2]);
});
