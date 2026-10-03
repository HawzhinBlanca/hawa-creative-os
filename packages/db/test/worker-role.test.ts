import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { OutboxRepository } from '../src/repositories/outbox.repository.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { PostgresTelegramPollState, readTelegramKillSwitch } from '../src/telegram-poll-state.js';
import { provisionWorkerDatabase } from '../src/provision-worker-role.js';
import { isCanaryTask, readSendMarks, writeCanarySinkMark, writeSendMark } from '../../../apps/worker/src/delivery-notification.js';

const ownerUrl=process.env.TEST_DATABASE_OWNER_URL!;
const app=createDb(process.env.TEST_DATABASE_URL!);
const workerUrl=new URL(ownerUrl); workerUrl.username='hawa_worker_login'; workerUrl.password=randomBytes(32).toString('hex');
const worker=createDb(workerUrl.toString());
const owner=new pg.Client({connectionString:ownerUrl});
const tenantId='00000000-0000-4000-a000-000000000001';
const userId='00000000-0000-4000-b000-000000000011';
const scope={tenantId,userId,role:'operator'};
let taskId: string;
beforeAll(async()=>{
  await owner.connect();
  // CREATE DATABASE ... TEMPLATE copies schema, not database ACLs from migration 073.
  const database=decodeURIComponent(new URL(ownerUrl).pathname.slice(1));
  if (!/^hawa_t_[a-z0-9_]+$/.test(database)) throw new Error('An isolated per-file clone is required');
  await owner.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await owner.query(`GRANT TEMPORARY ON DATABASE ${database} TO hawa_app`);
  await provisionWorkerDatabase(ownerUrl,workerUrl.toString());
  taskId=(await withRlsContext(app,scope,tx=>new TaskRepository(app).createTaskAggregate({
    tenantId,userId,idempotencyKey:randomUUID(),title:'Worker role fixture',clientId:null,
    actorType:'user',actorId:userId,enqueueOutbox:false,
  },tx))).task.id;
});
afterAll(async()=>{await worker.destroy(); await app.destroy(); await owner.end();});

it('uses an independent login with no app membership, DDL, role switching or broad mutation even with operator context',async()=>{
  const identities=await withRlsContext(worker,scope,async tx=>(await sql<{name:string;app:boolean}>`SELECT current_user AS name, pg_has_role(current_user,'hawa_app','MEMBER') AS app`.execute(tx)).rows[0]);
  expect(identities).toEqual({name:'hawa_worker_login',app:false});
  const allowed=(await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hawa' AND has_function_privilege('hawa_worker_login',p.oid,'EXECUTE') ORDER BY p.proname`)).rows.map((r:{proname:string})=>r.proname);
  expect(allowed).toEqual(['can_access_client','can_write_client','current_customer_id','current_tenant_id','current_user_id','customer_can_request','customer_owns_web_request','customer_request_client_ids','has_tenant_role','is_tenant_member','member_client_ids']);
  for(const statement of [
    'SET ROLE hawa_app','SET ROLE hawa_worker','CREATE ROLE worker_escape','CREATE SCHEMA worker_escape',
    'CREATE TEMP TABLE tasks(id uuid)',
    'UPDATE hawa.tasks SET title=title','DELETE FROM hawa.tasks',
    'INSERT INTO hawa.approvals DEFAULT VALUES','SELECT * FROM hawa.canva_connections',
    'SELECT * FROM hawa.users','SELECT * FROM hawa.integrations WHERE config_encrypted IS NOT NULL',
    "SELECT hawa.studio_scope_budget_internal('00000000-0000-4000-a000-000000000001',NULL)",
  ]) {
    await expect(withRlsContext(worker,scope,tx=>sql.raw(statement).execute(tx)),statement).rejects.toMatchObject({code:'42501'});
  }
});
it('can enqueue, claim, renew, record send marks and finish a durable outbox command',async()=>{
  const repo=new OutboxRepository(worker), key=randomUUID();
  await withRlsContext(worker,scope,tx=>repo.enqueue({tenantId,aggregateType:'task',aggregateId:taskId,
    commandType:'notify.telegram',idempotencyKey:key,payload:{text:'synthetic'}},tx));
  const command=await withRlsContext(worker,scope,async tx=>{
    const due=await repo.claimDue(100,60,12,tx); return due.find(row=>row.idempotency_key===key)!;
  });
  expect(command).toBeDefined();
  expect(await withRlsContext(worker,scope,tx=>repo.renewClaim(command.id,command.claim_token,120,tx))).toBeTruthy();
  await withRlsContext(worker,scope,tx=>writeSendMark(tx,tenantId,command.id,'summary','message','sent','123'));
  const marks=await withRlsContext(worker,scope,tx=>readSendMarks(tx,tenantId,command.id));
  expect(marks.get('summary')?.outcome).toBe('sent');
  expect((await withRlsContext(worker,scope,tx=>repo.markDelivered(command.id,tx))).state).toBe('delivered');
});
it('advances the actual poll cursor monotonically but cannot release the office kill switch or insert provider config',async()=>{
  const bot='bot-987654321', state=new PostgresTelegramPollState(worker,scope,bot);
  await state.setOffset(100); await state.setOffset(90); expect(await state.getOffset()).toBe(100);
  const kill=randomUUID();
  await withRlsContext(app,scope,async tx=>{
    await sql`INSERT INTO hawa.integrations(id,tenant_id,kind,name) VALUES(${kill}::uuid,${tenantId}::uuid,'telegram','office-kill-switch')`.execute(tx);
    await sql`INSERT INTO hawa.integration_health(integration_id,tenant_id,state) VALUES(${kill}::uuid,${tenantId}::uuid,'disabled')`.execute(tx);
  });
  expect(await readTelegramKillSwitch(worker,scope)).toBe(true);
  const changed=await withRlsContext(worker,scope,tx=>sql`UPDATE hawa.integration_health SET state='healthy' WHERE integration_id=${kill}::uuid RETURNING integration_id`.execute(tx));
  expect(changed.rows).toHaveLength(0); expect(await readTelegramKillSwitch(worker,scope)).toBe(true);
  await expect(withRlsContext(worker,scope,tx=>sql`INSERT INTO hawa.integrations(tenant_id,kind,name,config_public)
    VALUES(${tenantId}::uuid,'model_provider','worker-escalation','{}')`.execute(tx))).rejects.toMatchObject({code:'42501'});
});
it('ADR-240: can record a canary sink mark and read whether a task is the canary chat\'s',async()=>{
  const canary=String(2**52+11), key=`lc:canary-role-${randomUUID()}`;
  await withRlsContext(worker,scope,tx=>writeCanarySinkMark(tx,tenantId,key,'send','message',
    {messageId:String(2**50+1),chatId:canary,reason:'canary_chat',kind:'text',text:'Got it.'}));
  const row=(await owner.query(`SELECT event_kind FROM hawa.inbox_events WHERE source_event_id=$1`,[`${key}:send`])).rows[0];
  expect(row).toEqual({event_kind:'telegram_message_canary_sink'});
  expect(await withRlsContext(worker,scope,tx=>isCanaryTask(tx,tenantId,taskId,canary))).toBe(false);
});
it('retains tenant RLS and permits delivery-source reads without mutation grants',async()=>{
  const invisible=await withRlsContext(worker,{...scope,tenantId:'00000000-0000-4000-a000-000000000005'},tx=>sql`SELECT id FROM hawa.tasks WHERE id=${taskId}::uuid`.execute(tx));
  expect(invisible.rows).toHaveLength(0);
  for(const table of ['canva_export_bytes','design_studio_runs','design_studio_candidates','blobs']) {
    await withRlsContext(worker,scope,tx=>sql.raw(`SELECT * FROM hawa.${table} LIMIT 1`).execute(tx));
    await expect(withRlsContext(worker,scope,tx=>sql.raw(`DELETE FROM hawa.${table}`).execute(tx))).rejects.toMatchObject({code:'42501'});
  }
});
it('preserves Core function permissions and refuses provisioning onto an unexpected privileged membership',async()=>{
  const functions=(await owner.query(`SELECT has_function_privilege('hawa_app','hawa.current_tenant_id()','EXECUTE') AS helper,
    has_function_privilege('hawa_app','hawa.studio_scope_budget_internal(uuid,uuid)','EXECUTE') AS internal`)).rows[0];
  expect(functions).toEqual({helper:true,internal:false});
  await owner.query('GRANT hawa_app TO hawa_worker_login');
  try {await expect(provisionWorkerDatabase(ownerUrl,workerUrl.toString())).rejects.toThrow('provisioning or privilege');}
  finally {await owner.query('REVOKE hawa_app FROM hawa_worker_login');}
});
