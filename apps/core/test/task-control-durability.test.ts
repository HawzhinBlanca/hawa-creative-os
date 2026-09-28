import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';

const db=createDb(process.env.HAWA_ISOLATED_TEST_DB!);
const headers={'Content-Type':'application/json','x-user-role':'operator',Authorization:`Bearer ${process.env.HAWA_BEARER_TOKEN}`};
const app=()=>createApp({db,testAuth:{roleHeader:true}});
const state=async(id:string)=>(await sql<{state:string;version:number}>`SELECT state,version::integer AS version FROM hawa.tasks WHERE id=${id}::uuid`.execute(db)).rows[0];
const make=async()=>{
  const r=await app().request('/v1/tasks',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({
    title:'Synthetic task controls',clientId:'c1000000-0000-4000-8000-000000000002',
  })});
  expect(r.status).toBe(201);return (await r.json()).id as string;
};
const act=(id:string,control:string,version:number,key:string=randomUUID(),reason='Synthetic operator decision',role?:string)=>app().request(`/v1/tasks/${id}/${control}`,{
  method:'POST',headers:{...headers,'Idempotency-Key':key,...(role?{'x-user-role':role}:{})},body:JSON.stringify({expectedVersion:version,reason}),
});
beforeAll(async()=>{
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES('c1000000-0000-4000-8000-000000000002','00000000-0000-4000-a000-000000000001','kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);
});
afterAll(()=>db.destroy());
describe('durable task controls and generation authority',()=>{
  it('persists a real cancellation and replays its receipt across Core instances',async()=>{
    const id=await make(),before=await state(id),key=randomUUID();
    const one=await act(id,'cancel',Number(before.version),key);expect(one.status).toBe(202);
    const receipt=await one.json();expect(receipt.status).toBe('CANCELLED');
    const two=await act(id,'cancel',Number(before.version),key);expect(two.status).toBe(202);
    expect(await two.json()).toEqual({...receipt,replayed:true});
    expect(await state(id)).toMatchObject({state:'cancelled',version:Number(before.version)+1});
    const events=(await sql<{actor_id:string;data:Record<string,unknown>}>`SELECT actor_id,data FROM hawa.task_events WHERE task_id=${id}::uuid AND data->>'controlKey'=${key}`.execute(db)).rows;
    expect(events).toHaveLength(1);expect(events[0].actor_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[0].data).toMatchObject({fromState:'received',toState:'cancelled',reason:'Synthetic operator decision'});
    expect((await act(id,'resume',Number(before.version)+1)).status).toBe(409);
    const fetcher=vi.fn();
    const reply=await createApp({db,telegramBridge:{dispatchOutboundMessage:fetcher} as any}).request(`/v1/tasks/${id}/redrive`,{method:'POST',headers,body:'{}'});
    expect(reply.status).toBe(409);expect(fetcher).not.toHaveBeenCalled();
  });
  it('restores the actual operator pause checkpoint and preserves historical replay after resume',async()=>{
    const id=await make(),before=await state(id),key=randomUUID();
    const paused=await act(id,'pause',Number(before.version),key);expect(paused.status).toBe(202);
    const receipt=await paused.json();expect(await state(id)).toMatchObject({state:'paused'});
    const resumed=await act(id,'resume',Number(receipt.version));expect(resumed.status).toBe(202);
    expect(await state(id)).toMatchObject({state:'received',version:Number(before.version)+2});
    expect(await (await act(id,'pause',Number(before.version),key)).json()).toEqual({...receipt,replayed:true});
    expect((await state(id)).state).toBe('received');
  });
  it('serializes competing decisions and rejects altered idempotency payloads',async()=>{
    const id=await make(),before=await state(id),key=randomUUID();
    const replies=await Promise.all([act(id,'pause',Number(before.version),key),act(id,'cancel',Number(before.version))]);
    expect(replies.map(r=>r.status).sort()).toEqual([202,409]);
    expect(Number((await state(id)).version)).toBe(Number(before.version)+1);
    // A separate task fixes which command won for the changed-payload assertion.
    const other=await make(),original=await state(other);
    expect((await act(other,'pause',Number(original.version),key)).status).toBe(202);
    expect((await act(other,'cancel',Number(original.version),key)).status).toBe(409);
  });
  it('does not invent a checkpoint for a requester question or claim a retry ran',async()=>{
    const id=await make();await sql`UPDATE hawa.tasks SET state='paused' WHERE id=${id}::uuid`.execute(db);
    expect((await act(id,'resume',Number((await state(id)).version))).status).toBe(409);
    expect((await act(id,'retry',Number((await state(id)).version))).status).toBe(409);
    expect((await state(id)).state).toBe('paused');
  });
  it('requires reason, revision and key and refuses requester authority',async()=>{
    const id=await make(),before=await state(id);
    expect((await act(id,'cancel',Number(before.version),randomUUID(),'')).status).toBe(422);
    expect((await act(id,'cancel',Number(before.version),'short')).status).toBe(422);
    expect((await act(id,'cancel',0)).status).toBe(422);
    expect((await act(id,'cancel',Number(before.version),randomUUID(),'Unauthorized','requester')).status).toBe(403);
    expect(await state(id)).toEqual(before);
  });
  it('does not report acceptance or change durable state when recording the event fails',async()=>{
    const id=await make(),before=await state(id);
    // A targeted test-only trigger aborts this task's control event, rolling back its state update.
    const functionName=`reject_control_${id.replaceAll('-','')}`;
    await sql.raw(`CREATE FUNCTION hawa.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${id}'::uuid AND NEW.data ? 'operatorControl' THEN RAISE EXCEPTION 'synthetic event failure'; END IF; RETURN NEW; END $$`).execute(db);
    await sql.raw(`CREATE TRIGGER ${functionName} BEFORE INSERT ON hawa.task_events FOR EACH ROW EXECUTE FUNCTION hawa.${functionName}()`).execute(db);
    try {
      expect((await act(id,'cancel',Number(before.version))).status).toBe(503);
      expect(await state(id)).toEqual(before);
    } finally {
      await sql.raw(`DROP TRIGGER ${functionName} ON hawa.task_events`).execute(db);
      await sql.raw(`DROP FUNCTION hawa.${functionName}()`).execute(db);
    }
  });
});
