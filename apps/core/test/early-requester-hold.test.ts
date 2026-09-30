import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { acceptEarlyHold, earlyHoldsFor } from '../src/services/early-requester-hold.js';
import { briefAnchorFor, lockBriefAnchor } from '../src/services/lifecycle-brief-anchor.js';
import { holdBrief } from '../src/services/lifecycle-album.js';
import { recordNewBriefDecision } from '../src/services/lifecycle-chat-target.js';
import { projectLifecycleOpen, type OpenLifecycleProjection } from '../src/services/lifecycle-projection.js';
import { controlTask } from '../src/services/task-control-service.js';
import { ConversationHarness } from './fixtures/conversation-harness.js';
import { Play } from './fixtures/conversation-script.js';
import { KAAE_EVENING } from './fixtures/nl-scripts/briefs.js';

const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId='00000000-0000-4000-a000-000000000001',userId='00000000-0000-4000-b000-000000000001';
const scope={tenantId,userId,role:'operator' as const};
let serial=1_900_000_000+Math.floor(Math.random()*100_000);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await db.destroy();await owner.destroy();});
const taskState=(taskId:string)=>withRlsContext(db,scope,trx=>trx.selectFrom('tasks').select(['state','version'])
  .where('id','=',taskId).executeTakeFirstOrThrow());
const resume=(taskId:string,version:number)=>controlTask(db,{tenantId,actorId:userId,role:'operator'},taskId,'resume',
  {expectedVersion:version,key:randomUUID(),reason:'Office checked the original requester words'});

async function fixture(manual=false,siblings=false) {
  const u=++serial,chat=String(u),sender=String(u+1),requestId=randomUUID();
  const update={update_id:u,message:{message_id:u,date:Math.floor(Date.now()/1000),
    chat:{id:u,type:'private'},from:{id:u+1,first_name:'Synthetic requester'},text:KAAE_EVENING}};
  const anchor=await withRlsContext(db,scope,async trx=>{
    await holdBrief(trx,tenantId,update);return (await briefAnchorFor(trx,tenantId,update))!;
  });
  const draft={platform:'telegram' as const,sourceEventId:`lc-${requestId}-r0`,sourceChannelId:chat,
    title:'Synthetic early hold',rawText:KAAE_EVENING,exactCopy:['Synthetic early hold'],designInstructions:'Use supplied copy',
    clientId:'c1000000-0000-4000-8000-000000000002',autoGenerate:!manual,designStudio:false};
  const siblingId=randomUUID(),siblingDraft={...draft,sourceEventId:`lc-${siblingId}-r0`};
  const decision=()=>withRlsContext(db,scope,trx=>recordNewBriefDecision(trx,tenantId,u,
    {requestId,chatId:chat,payloadHash:'a'.repeat(64),draft,briefAnchor:anchor,
      ...(siblings ? {siblings:[{requestId:siblingId,draft:siblingDraft}]} : {})}));
  const input={update:{...update,update_id:++serial,message:{...update.message,message_id:serial,text:"Wait, don't make it yet"}},
    text:"Wait, don't make it yet",answer:'The design is paused.',payloadHash:'b'.repeat(64),isHold:true};
  const projection:OpenLifecycleProjection={requestId,tenantId,expectedRev:0,rev:1,key:`${requestId}:1:open`,draft};
  return {anchor,update,input,decision,projection,chat,sender,siblingId,siblingDraft,
    hold:()=>withRlsContext(db,scope,trx=>acceptEarlyHold(trx,tenantId,input)),
    project:()=>projectLifecycleOpen(db,projection,null)};
}

/** Observe an actual blocked backend, so the test does not depend on a lucky scheduling delay. */
async function blocked(pid:number) {
  for (let i=0;i<100;i++) {
    const row=(await sql<{waiting:boolean}>`SELECT wait_event_type='Lock' AND wait_event='advisory' AS waiting
      FROM pg_stat_activity WHERE pid=${pid}`.execute(owner)).rows[0];
    if (row?.waiting) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('The competing transaction never waited on the brief anchor');
}

describe('early hold receipt and authoritative initial projection',()=>{
  it('replays the receipt and projection after resume without re-pausing; altered bytes are refused',async()=>{
    const f=await fixture();await f.hold();await f.decision();const projected=await f.project();
    expect(projected.requesterHold).toBe(true);const paused=await taskState(projected.taskId);
    await resume(projected.taskId,Number(paused.version));const resumed=await taskState(projected.taskId);
    expect(await f.hold()).toMatchObject({text:f.input.text});expect(await f.project()).toEqual(projected);
    expect(await taskState(projected.taskId)).toEqual(resumed);
    await expect(withRlsContext(db,scope,trx=>acceptEarlyHold(trx,tenantId,{...f.input,payloadHash:'c'.repeat(64),isHold:false})))
      .rejects.toThrow('Changed early-hold replay');
  });
  it('a failed receipt transaction leaves no pause policy or task side effect',async()=>{
    const f=await fixture();
    await expect(withRlsContext(db,scope,async trx=>{await acceptEarlyHold(trx,tenantId,f.input);throw new Error('receipt rollback');}))
      .rejects.toThrow('receipt rollback');
    expect(await withRlsContext(db,scope,trx=>earlyHoldsFor(trx,tenantId,f.anchor))).toEqual([]);
    await f.decision();const projected=await f.project();expect(projected.requesterHold).toBeUndefined();
    expect((await taskState(projected.taskId)).state).toBe('received');
  });
  it('does not accept another sender, chat, topic or foreign reply as a hold of this brief',async()=>{
    const f=await fixture();
    const changes=[{from:{id:Number(f.sender)+100}},{chat:{id:Number(f.chat)+100}},
      {message_thread_id:10},{reply_to_message:{message_id:10,from:{id:111}}}];
    for (const change of changes) expect(await withRlsContext(db,scope,trx=>acceptEarlyHold(trx,tenantId,
      {...f.input,update:{...f.input.update,update_id:++serial,message:{...f.input.update.message,...change}}}))).toBeNull();
    expect(await f.hold()).not.toBeNull();
  });
  it('an explicit own-brief reply can select one of several pending briefs',async()=>{
    const f=await fixture();
    await withRlsContext(db,scope,trx=>holdBrief(trx,tenantId,{...f.update,update_id:++serial,
      message:{...f.update.message,message_id:serial,text:'Another KAAE poster please'}}));
    expect(await f.hold()).toBeNull();
    const selected=await withRlsContext(db,scope,trx=>acceptEarlyHold(trx,tenantId,{...f.input,
      update:{...f.input.update,message:{...f.input.update.message,reply_to_message:f.update.message}}}));
    expect(selected?.anchor.updateId).toBe(f.anchor.updateId);
  });
  it('a brief that becomes manual retains a visible resumable hold without dispatching paid work',async()=>{
    const f=await fixture(true);await f.hold();await f.decision();const p=await f.project();
    expect(p).toMatchObject({stage:'manual',autoGenerate:false,requesterHold:true});
    const paused=await taskState(p.taskId);expect(paused.state).toBe('paused');
    await resume(p.taskId,Number(paused.version));expect((await taskState(p.taskId)).state).toBe('received');
  });
  it('an unbound hold cannot silently choose a pending brief over another active own design',async()=>{
    const f=await fixture();await f.decision();const existing=await f.project();
    const next={...f.update,update_id:++serial,message:{...f.update.message,message_id:serial,text:'Another KAAE poster please'}};
    await withRlsContext(db,scope,trx=>holdBrief(trx,tenantId,next));
    expect(await f.hold()).toBeNull();expect((await taskState(existing.taskId)).state).toBe('received');
    const selected=await withRlsContext(db,scope,trx=>acceptEarlyHold(trx,tenantId,{...f.input,
      update:{...f.input.update,message:{...f.input.update.message,reply_to_message:next.message}}}));
    expect(selected?.anchor.updateId).toBe(next.update_id);
  });
  it('language siblings inherit their original brief hold and cannot acquire another requester',async()=>{
    const f=await fixture(false,true);await f.hold();await f.decision();
    const [one,two]=await Promise.all([f.project(),projectLifecycleOpen(db,{...f.projection,requestId:f.siblingId,
      key:`${f.siblingId}:1:open`,draft:f.siblingDraft},null)]);
    expect(one.requesterHold).toBe(true);expect(two.requesterHold).toBe(true);
    expect((await taskState(one.taskId)).state).toBe('paused');expect((await taskState(two.taskId)).state).toBe('paused');
    const {activeChatRequests}=await import('../src/services/requester-turn-store.js');
    expect((await withRlsContext(db,scope,trx=>activeChatRequests(trx,tenantId,f.chat))).map(r=>r.requesterId))
      .toEqual([f.sender,f.sender]);
  });
  it('rejects worker mutation of the reviewed brief before creating a task',async()=>{
    const f=await fixture();await f.decision();
    await expect(projectLifecycleOpen(db,{...f.projection,draft:{...f.projection.draft,rawText:'Changed copy'}},null))
      .rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    const p=await f.project();expect((await taskState(p.taskId)).state).toBe('received');
  });
});

describe('real PostgreSQL brief lock orderings',()=>{
  it.each(['hold','projection'] as const)('%s wins; hold acknowledgement always leaves the task paused',async winner=>{
    vi.stubEnv('TELEGRAM_ALLOWED_USERS','95000001');
    const f=await fixture();await f.decision();const peer=createDb(process.env.TEST_DATABASE_URL!);
    let pending:Promise<unknown>|undefined,pid=0;
    try {
      await withRlsContext(db,scope,async trx=>{
        await lockBriefAnchor(trx,tenantId,f.anchor);
        pending=withRlsContext(peer,scope,async other=>{
          pid=(await sql<{pid:number}>`SELECT pg_backend_pid() AS pid`.execute(other)).rows[0].pid;
          return winner==='hold' ? projectLifecycleOpen(other,f.projection,null) : acceptEarlyHold(other,tenantId,f.input);
        });
        while (!pid) await new Promise(resolve=>setTimeout(resolve,1));
        await blocked(pid);
        if (winner==='hold') expect(await acceptEarlyHold(trx,tenantId,f.input)).not.toBeNull();
        else await projectLifecycleOpen(trx,f.projection,null);
      });
      const accepted=await pending;
      if (winner==='projection') expect(accepted).toMatchObject({officeAlerts:[{chatId:expect.any(String),text:expect.stringContaining(f.input.text)}]});
      const projected=await f.project();
      expect((await taskState(projected.taskId)).state).toBe('paused');
    } finally {await pending?.catch(()=>{});await peer.destroy();}
  });
});

it('photos that consume the held words carry their original hold into worker dispatch',async()=>{
  const office=[{id:++serial,name:'Office'}],states:string[]=[];
  const h=new ConversationHarness({db,owner,office,workerToken:randomUUID(),onDesignStart:async input=>{
    states.push((await taskState(input.taskId)).state);
  }});await h.emptyOfficeQueue();const p=new Play(h,office);
  await p.say(KAAE_EVENING);await p.say("Wait, don't make it yet",{after:1000});
  await p.album([701,702],{after:1000});await p.wait(20_000);
  expect(p.opened).toHaveLength(1);expect(states).toEqual(['paused']);
  expect(p.opened[0].draft.lifecycleAlbum.images).toHaveLength(2);
});

it('a held manual brief is acknowledged honestly and alerts every office member',async()=>{
  const office=[{id:++serial,name:'One'},{id:++serial,name:'Two'}];
  const h=new ConversationHarness({db,owner,office,workerToken:randomUUID()});
  vi.stubEnv('AUTO_GENERATE_CHAT_DESIGNS','false');await h.emptyOfficeQueue();const p=new Play(h,office);
  await p.say(KAAE_EVENING);await p.say("Wait, don't make it yet",{after:1000});await p.wait(20_000);
  expect(p.opened).toHaveLength(1);expect(h.t.designs).toHaveLength(0);
  expect((await h.taskState(p.request())).state).toBe('paused');
  expect(p.said.map(s=>s.text).join('\n')).not.toMatch(/a designer will make|making a first draft/i);
  for (const member of office) expect(h.t.sent.some(s=>s.chatId===String(member.id) && s.text.includes("Wait, don't make it yet"))).toBe(true);
});
