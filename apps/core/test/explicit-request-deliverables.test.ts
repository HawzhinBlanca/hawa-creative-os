import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { openingChatRequests, replyBindings } from '../src/services/requester-turn-store.js';
import { recentOpenBy } from '../src/services/lifecycle-media-intake.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const db=createDb(process.env.TEST_DATABASE_URL!);
const tenantId='00000000-0000-4000-a000-000000000001';
const scope={tenantId,userId:'00000000-0000-4000-b000-000000000001',role:'operator' as const};
const token=randomUUID();
const headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
let serial=1_300_000_000+Math.floor(Math.random()*10_000_000);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(()=>db.destroy());

function fixture(text:string) {
  vi.stubEnv('HAWA_WORKER_TOKEN',token);
  vi.stubEnv('TELEGRAM_ALLOWED_USERS','91000027');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL','1000000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER','1000000');
  const id=++serial,chat=id;
  const update={update_id:id,message:{message_id:id,date:1790000000,chat:{id:chat,type:'private'},
    from:{id:91000027,is_bot:false,first_name:'Synthetic requester'},text}};
  const app=createApp({db} as any);
  const intake=async(capacity=8,input:unknown=update)=>{
    const response=await app.request('/v1/internal/telegram/intake',{method:'POST',headers,
      body:JSON.stringify({v:1,mode:'legacy',update:input,languageSiblings:true,maxDeliverables:capacity})});
    return response.json() as Promise<any>;
  };
  const project=async(open:{requestId:string;draft:unknown})=>{
    const response=await app.request(`/v1/internal/lifecycle/${open.requestId}/project`,{method:'POST',headers,
      body:JSON.stringify({v:1,expectedRev:0,rev:1,key:`${open.requestId}:1:open`,ops:[{kind:'createRequest',draft:open.draft}]})});
    return {status:response.status,body:await response.json() as any};
  };
  const tasks=()=>withRlsContext(db,scope,trx=>sql<{id:string}>`SELECT t.id FROM hawa.requests r JOIN hawa.tasks t
    ON t.tenant_id=r.tenant_id AND t.id=r.current_task_id WHERE r.tenant_id=${tenantId}::uuid AND r.chat_id=${String(chat)}`.execute(trx));
  return {app,chat,update,intake,project,tasks};
}
const opens=(body:any):Array<{requestId:string;draft:any}>=>[{requestId:body.requestId,draft:body.draft},...(body.siblings??[])];

describe('explicit deliverables through real Core decisions and task projection',()=>{
  it('creates three independent tasks with scoped facts/formats and preserves all replay identities',async()=>{
    const f=fixture('Create 3 designs for KAAE:\n1) Poster for graduation on 12 October 2026 at Rotana\n2) Instagram story for open day on 20 October 2026 at campus\n3) Square post for workshop on 25 October 2026 at Erbil hall');
    const answer=await f.intake();
    expect(answer).toMatchObject({lifecycleAction:'open-request',deliverableCount:3});
    const children=opens(answer);
    expect(children).toHaveLength(3);
    expect(children.map(c=>c.draft.variant)).toEqual([{width:1080,height:1350},{width:1080,height:1920},{width:1080,height:1080}]);
    expect(await withRlsContext(db,scope,trx=>openingChatRequests(trx,tenantId,String(f.chat)))).toEqual(expect.arrayContaining(children.map(c=>c.requestId)));
    const tasks=[];
    for(const [i,child] of children.entries()) {
      expect(child.draft.autoGenerate).toBe(true);
      for(const [j,date] of ['12 October','20 October','25 October'].entries())
        expect(child.draft.rawText.includes(date)).toBe(i===j);
      const projected=await f.project(child);
      expect(projected.status).toBe(200);
      expect(projected.body).toMatchObject({stage:'designing',autoGenerate:true});
      tasks.push(projected.body.taskId);
      expect(await f.project(child)).toEqual(projected);
    }
    expect(new Set(tasks).size).toBe(3);
    expect((await f.tasks()).rows).toHaveLength(3);
    expect(await f.intake()).toMatchObject({duplicate:true,draft:answer.draft,siblings:answer.siblings,deliverableCount:3});
    expect(await f.intake(2)).toMatchObject({intakeStatus:503,code:'LANGUAGE_SIBLINGS_UNSUPPORTED'});
    expect(await f.intake(8,{...f.update,message:{...f.update.message,text:'Changed source bytes'}})).toMatchObject({intakeStatus:409,code:'IDEMPOTENCY_CONFLICT'});
    expect(await withRlsContext(db,scope,trx=>openingChatRequests(trx,tenantId,String(f.chat)))).toEqual([]);
    const bindings=await withRlsContext(db,scope,trx=>replyBindings(trx,tenantId,String(f.chat),String(f.update.message.message_id)));
    expect(new Set(bindings.requestIds)).toEqual(new Set(children.map(c=>c.requestId)));
    const recent=await withRlsContext(db,scope,trx=>recentOpenBy(trx,tenantId,{chatId:String(f.chat),senderId:'91000027',topic:''},Date.now()+1000));
    expect(recent?.ambiguous).toBe(true);
  });
  it('does not authorize one child when the worker cannot carry the whole bundle',async()=>{
    const f=fixture('Create 3 designs for KAAE: a poster for graduation and a story for open day and a banner for workshop');
    expect(await f.intake(2)).toMatchObject({intakeStatus:503});
    expect((await f.tasks()).rows).toEqual([]);
    expect(await withRlsContext(db,scope,trx=>openingChatRequests(trx,tenantId,String(f.chat)))).toEqual([]);
    expect(opens(await f.intake())).toHaveLength(3);
  });
  it('refuses the complete over-limit request instead of producing a truncated batch',async()=>{
    const f=fixture('Create 9 designs for KAAE: graduation at Erbil hall on 12 October');
    expect(await f.intake()).toMatchObject({intakeStatus:422,code:'DELIVERABLE_LIMIT'});
    expect((await f.tasks()).rows).toEqual([]);
    expect(await withRlsContext(db,scope,trx=>openingChatRequests(trx,tenantId,String(f.chat)))).toEqual([]);
  });
  it('preserves an ambiguous count as separate manual tasks with structured office diagnostics',async()=>{
    const f=fixture('We need 2 designs for KAAE: first for graduation, second for open day, dates to follow');
    const children=opens(await f.intake());
    expect(children).toHaveLength(2);
    for(const child of children) {
      expect(child.draft).toMatchObject({autoGenerate:false,isInstructionOnly:true});
      const projected=await f.project(child);
      expect(projected.body).toMatchObject({stage:'manual',autoGenerate:false,autoGenerateDeclined:'DELIVERABLE_DETAILS_REQUIRED'});
      expect(projected.body.officeAlerts).toEqual(expect.arrayContaining([expect.objectContaining({text:expect.stringContaining('DELIVERABLE_DETAILS_REQUIRED')})]));
    }
    expect((await f.tasks()).rows).toHaveLength(2);
  });
  it('refuses an altered child canvas or manual admission without creating its task',async()=>{
    const f=fixture('Create 2 designs for KAAE: first for graduation, second for open day');
    const child=opens(await f.intake())[1];
    const changed=await f.project({...child,draft:{...child.draft,autoGenerate:true,variant:{width:1000,height:1200}}});
    expect(changed.status).toBe(409);
    expect((await f.tasks()).rows).toEqual([]);
    expect((await f.project(child)).body.stage).toBe('manual');
  });
  it('keeps the daily cap per task while preserving the requested number',async()=>{
    const f=fixture('Create 2 designs for KAAE: a poster for graduation and a story for open day');
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER','1');
    const children=opens(await f.intake());
    const first=await f.project(children[0]),second=await f.project(children[1]);
    expect(first.body).toMatchObject({stage:'designing',autoGenerate:true});
    expect(second.body).toMatchObject({stage:'manual',autoGenerate:false,autoGenerateDeclined:'SENDER_DAILY_CAP'});
    expect((await f.tasks()).rows).toHaveLength(2);
  });
  it('admits only one automatic task under concurrent distinct source events and retains the replay outcome',async()=>{
    const f=fixture('Create 2 designs for KAAE: a poster for graduation and a story for open day');
    const children=opens(await f.intake());
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER','1');
    const results=await Promise.all(children.map(child=>persistChatIntake(db,child.draft,{outboxState:'recorded'})));
    expect(results.filter(r=>!r.autoGenerateDeclined)).toHaveLength(1);
    expect(results.filter(r=>r.autoGenerateDeclined==='SENDER_DAILY_CAP')).toHaveLength(1);
    for(const [i,result] of results.entries()) {
      const replay=await persistChatIntake(db,children[i].draft,{outboxState:'recorded'});
      expect(replay.created).toBe(false);
      expect(replay.task.id).toBe(result.task.id);
      expect(replay.autoGenerateDeclined).toBe(result.autoGenerateDeclined);
    }
  });
  it('locks each named client before its own retrieval and keeps onboarding work manual',async()=>{
    const f=fixture('Create 2 designs: a poster for KAAE graduation on 12 October and a thumbnail for ZAR Podcast episode on 20 October');
    const children=opens(await f.intake());
    expect(children.map(c=>c.draft.clientId)).toEqual(['c1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000011']);
    expect(children.map(c=>c.draft.autoGenerate)).toEqual([true,false]);
    expect(children[1].draft.variant).toEqual({width:1280,height:720});
    expect(children[0].draft.rawText).not.toContain('ZAR Podcast');
    expect(children[1].draft.rawText).not.toContain('KAAE');
    for(const child of children) expect((await f.project(child)).status).toBe(200);
  });
  it('does not route a child to a client mentioned only in a negation',async()=>{
    const f=fixture('Create 2 designs: a poster for KAAE graduation on 12 October 2026 and a thumbnail for ZAR Podcast episode on 20 October 2026, not KAAE');
    const children=opens(await f.intake());
    expect(children[1].draft.clientId).toBe('c1000000-0000-4000-8000-000000000011');
    expect(children[1].draft.autoGenerate).toBe(false);
    expect(children[1].draft.isInstructionOnly).toBe(false);
  });
  it('refuses an unsupported requested canvas explicitly without silently using a default',async()=>{
    const f=fixture('Create 2 designs for KAAE:\n1) Poster for graduation\nSize: 5000x4000\n2) Story for open day');
    expect(await f.intake()).toMatchObject({intakeStatus:422,code:'UNSUPPORTED_CANVAS',chatAnswer:{text:expect.stringContaining('5000 × 4000')}});
    expect((await f.tasks()).rows).toEqual([]);
  });
});
