import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, sql, withRlsContext } from '../src/index.js';

const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
async function fixture(role='administrator',action='client.model_consent.granted') {
  const tenantId=randomUUID(),userId=randomUUID(),clientId=randomUUID(),versionId=randomUUID(),taskId=randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Synthetic consent office',${tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic consent actor')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,${role}::hawa.membership_role)`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Synthetic consent client')`.execute(owner);
  const privacy=action==='client.model_consent.withdrawn'?{modelEgressMode:'local_only',allowedProviders:[]}:
    {modelEgressMode:'approved_providers',allowedProviders:['openai']};
  await sql`INSERT INTO hawa.client_dna_versions(id,tenant_id,client_id,version,status,dna,content_hash,approved_by)
    VALUES(${versionId}::uuid,${tenantId}::uuid,${clientId}::uuid,2,'active',${JSON.stringify({privacy})}::jsonb,${'a'.repeat(64)},${userId}::uuid)`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic consent task')`.execute(owner);
  return {tenantId,userId,clientId,versionId,taskId};
}
async function insert(f:Awaited<ReturnType<typeof fixture>>,over:Record<string,string|null>={}) {
  const actorId=over.actorId ?? f.userId,resource=over.resource ?? f.versionId,client=over.client ?? f.clientId;
  return withRlsContext(db,{tenantId:f.tenantId,userId:f.userId,role:'administrator'},trx=>sql`
    INSERT INTO hawa.audit_events(tenant_id,client_id,task_id,actor_type,actor_id,action,resource_type,resource_id,after_hash)
    VALUES(${f.tenantId}::uuid,${client}::uuid,${over.taskId ?? null}::uuid,'user',${actorId},
      ${over.action ?? 'client.model_consent.granted'},${over.resourceType ?? 'client_dna_version'},${resource},${over.hash ?? 'a'.repeat(64)})`.execute(trx));
}
it.each(['client.model_consent.granted','client.model_consent.withdrawn'])('admits %s only under real stored administrator and DNA authority',async action=>{
  const f=await fixture('administrator',action);expect((await insert(f,{action})).numAffectedRows).toBe(1n);
  expect((await sql`SELECT actor_id FROM hawa.audit_events WHERE client_id=${f.clientId}::uuid`.execute(owner)).rows).toEqual([{actor_id:f.userId}]);
});
it.each(['operator','designer','approver','auditor'])('denies %s even with a forged administrator context',async role=>{
  await expect(insert(await fixture(role))).rejects.toMatchObject({code:'42501'});
});
it.each(['disabled','inactive'])('denies the %s actual administrator',async condition=>{
  const f=await fixture();
  if(condition==='disabled')await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${f.userId}::uuid`.execute(owner);
  else await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${f.userId}::uuid`.execute(owner);
  await expect(insert(f)).rejects.toMatchObject({code:'42501'});
});
it.each(['actor','source','client','hash','type','task'])('denies a mismatched %s without a task-policy bypass',async kind=>{
  const f=await fixture();const over:Record<string,string|null>=kind==='actor'?{actorId:randomUUID()}:kind==='source'?{resource:randomUUID()}:
    kind==='client'?{client:randomUUID()}:kind==='hash'?{hash:'b'.repeat(64)}:kind==='type'?{resourceType:'candidate_rule'}:{taskId:f.taskId};
  await expect(insert(f,over)).rejects.toMatchObject({code:'42501'});
});
it('cannot record a grant against a snapshot that actually withdrew consent',async()=>{
  await expect(insert(await fixture('administrator','client.model_consent.withdrawn'))).rejects.toMatchObject({code:'42501'});
});
it('forward policy reapplication preserves policy identities, existing reads and table grants',async()=>{
  const migration=readFileSync(new URL('../migrations/081_model_consent_audit_authority.sql',import.meta.url),'utf8')
    .replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
  await owner.transaction().execute(async trx=>{
    const policies=async()=>(await sql`SELECT oid::text,polname,polcmd,polpermissive,polroles::text,
      pg_get_expr(polqual,polrelid) AS read,pg_get_expr(polwithcheck,polrelid) AS write
      FROM pg_policy WHERE polrelid='hawa.audit_events'::regclass ORDER BY oid`.execute(trx)).rows;
    const grants=async()=>(await sql`SELECT oid::text,relacl::text FROM pg_class
      WHERE relnamespace='hawa'::regnamespace ORDER BY oid`.execute(trx)).rows;
    const before=await policies(),acl=await grants();
    await sql.raw(migration).execute(trx);expect(await policies()).toEqual(before);expect(await grants()).toEqual(acl);
    expect(before.filter(p=>String(p.polname).startsWith('audit_events_model_consent_'))).toHaveLength(2);
  });
});
