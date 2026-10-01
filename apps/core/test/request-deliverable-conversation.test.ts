import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, withRlsContext } from '@hawa/db';
import { ConversationHarness, TENANT } from './fixtures/conversation-harness.js';
import { Play } from './fixtures/conversation-script.js';
import { pendingLateChanges, acknowledgeLateChange } from '../src/services/lifecycle-chat-target.js';

const db=createDb(process.env.TEST_DATABASE_URL!),owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const workerToken=randomUUID();
const source='We need 2 designs for KAAE: a poster for graduation on 12 October 2026 at Rotana, and an Instagram story for open day on 20 October 2026 at campus.';
const scope={tenantId:TENANT,userId:'00000000-0000-4000-b000-000000000001',role:'operator' as const};
let officeSeed=96_000_000+Math.floor(Math.random()*100_000)*10;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await db.destroy();await owner.destroy();});
async function fixture() {
  const office=[{id:++officeSeed,name:'Office'}];
  const h=new ConversationHarness({db,owner,office,workerToken});await h.emptyOfficeQueue();
  return {h,p:new Play(h,office),office};
}

describe('deliverables carried by the actual ChatInbox, lifecycle and TelegramSender',()=>{
  it('sends both manual diagnoses to the office under separate durable keys with no design dispatch',async()=>{
    const {h,p,office}=await fixture();
    await p.say('We need 2 designs for KAAE: first for graduation, second for open day, dates to follow');await p.wait(30_000);
    expect(p.opened).toHaveLength(2);
    expect((await h.requests(p.chatId)).map(r=>r.stage)).toEqual(['manual','manual']);
    expect(h.t.designs).toHaveLength(0);
    const alerts=h.said(String(office[0].id)).filter(s=>s.text.includes('DELIVERABLE_DETAILS_REQUIRED'));
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map(s=>s.key)).size).toBe(2);
    expect(h.t.paidCalls).toEqual([]);
  });
  it('asks which design an unattached photo belongs to and changes neither child silently',async()=>{
    const {h,p}=await fixture();await p.say(source);await p.wait(30_000);
    await p.photo(1,{after:1000});await p.wait(30_000);
    expect(p.opened).toHaveLength(2);
    for(const child of p.opened) expect(await h.photosOf(child.requestId)).toBe(0);
    expect(p.words).toContain('Which one is this for?');
    expect(p.words).toContain('graduation');
    expect(p.words).toContain('open day');
    expect(h.t.paidCalls).toEqual([]);
  });
  it('retains a shared source edit for every child and requires independent office acknowledgements',async()=>{
    const {h,p}=await fixture();const original=await p.say(source);await p.wait(30_000);
    const before=p.opened.map(o=>o.draft.rawText);
    const edited=await p.edit(original,'We need 2 designs for KAAE: graduation changed to 15 October and open day changed to 23 October');
    expect(p.opened).toHaveLength(2);
    expect(p.opened.map(o=>o.draft.rawText)).toEqual(before);
    expect(h.t.revisions).toHaveLength(0);
    const notes=await Promise.all(p.opened.map(o=>withRlsContext(db,scope,trx=>pendingLateChanges(trx,TENANT,o.requestId))));
    expect(notes.map(n=>n.length)).toEqual([1,1]);
    expect(notes.map(n=>n[0].updateId)).toEqual(p.opened.map(o=>`${edited.updateId}:${o.requestId}`));
    for(const child of notes) expect(child[0].text).toContain('15 October');
    await withRlsContext(db,scope,trx=>acknowledgeLateChange(trx,TENANT,{requestId:p.opened[0].requestId,updateId:notes[0][0].updateId,
      actorUserId:scope.userId,actorRole:'operator',actionId:randomUUID()}));
    expect(await withRlsContext(db,scope,trx=>pendingLateChanges(trx,TENANT,p.opened[0].requestId))).toEqual([]);
    expect(await withRlsContext(db,scope,trx=>pendingLateChanges(trx,TENANT,p.opened[1].requestId))).toHaveLength(1);
    expect(h.t.paidCalls).toEqual([]);
  });
});
