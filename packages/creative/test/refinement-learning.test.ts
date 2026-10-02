import { describe, expect, it } from 'vitest';
import { FeedbackMiner, type ArtboardSnapshot } from '../src/feedback-miner.js';
import { refinementSnapshotFromManifest, refinementSnapshotHash, type ApprovedRefinementEvidence } from '../src/refinement-evidence.js';

const snapshots = (taskId='task-a', text='Approved copy'): [ArtboardSnapshot, ArtboardSnapshot] => [
  {clientId:'client-a',taskId,layers:[{id:'one',type:'text',text:'Old copy',color:'#000000',x:0,y:0,width:100,height:50},
    {id:'two',type:'shape',color:'#000000',x:0,y:100,width:100,height:50}]},
  {clientId:'client-a',taskId,layers:[{id:'one',type:'text',text,color:'#01585F',x:0,y:25,width:100,height:50},
    {id:'two',type:'shape',color:'#01585F',x:0,y:100,width:100,height:50}]},
];
// Pure policy tests use an explicit authority double; HTTP tests verify actual stored rows.
const authority = (a:ArtboardSnapshot,b:ArtboardSnapshot,id='event-a'):ApprovedRefinementEvidence => ({
  feedbackId:id,clientId:a.clientId,taskId:a.taskId,beforeRevisionId:'revision-before',afterRevisionId:'revision-after',
  beforeSourceSha256:'a'.repeat(64),afterSourceSha256:'b'.repeat(64),
  beforeSnapshotSha256:refinementSnapshotHash(a),afterSnapshotSha256:refinementSnapshotHash(b),
  approvalId:'approval-a',approvedBy:'director-a',actor:{id:'reviewer-a',role:'designer'},
});

describe('Independent approved refinement evidence', () => {
  it('counts a multi-layer correction and every replay as one task', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots();
    const first=miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,authority(a,b));
    const palette=first.find(r=>r.category==='palette')!;
    expect(palette.frequency).toBe(1);
    const before=palette.confidence;
    expect(miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,authority(a,b))).toEqual([]);
    expect(palette.frequency).toBe(1);expect(palette.confidence).toBe(before);
    const [c,d]=snapshots('task-b');
    miner.ingestTaskRefinements(c.clientId,c.taskId,c,d,authority(c,d,'event-b'));
    expect(palette.frequency).toBe(2);expect(palette.evidenceTaskIds).toEqual(['task-a','task-b']);
  });
  it('retains complete revision evidence for a new pair without counting the task twice', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots();
    const palette=miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,authority(a,b)).find(r=>r.category==='palette')!;
    const evidence={...authority(a,b,'event-second'),afterRevisionId:'revision-second'};
    miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,evidence);
    expect(palette.frequency).toBe(1);
    expect(palette.refinementEvidence).toEqual([authority(a,b),evidence]);
  });
  it('does not manufacture approved examples from unverified snapshots', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots();
    for(const rule of miner.ingestTaskRefinements(a.clientId,a.taskId,a,b)) expect(rule.examples.positiveExampleTaskIds).toEqual([]);
  });
  it('rejects mismatched task/client snapshots and altered authority hashes before proposing', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots();
    expect(()=>miner.ingestTaskRefinements(a.clientId,a.taskId,a,{...b,clientId:'client-b'},authority(a,b))).toThrow();
    expect(()=>miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,{...authority(a,b),afterSnapshotSha256:'c'.repeat(64)})).toThrow();
    expect(miner.getCandidateRules('client-a')).toEqual([]);
  });
  it('refuses changed authority reuse without accepting new evidence', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots();
    const first=miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,authority(a,b));
    expect(()=>miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,{...authority(a,b),approvalId:'approval-changed'})).toThrow();
    expect(first[0].refinementEvidence).toHaveLength(1);
  });
  it('keeps copy patterns that share a long prefix distinct', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots('task-a','A shared twenty character prefix: one');
    miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,authority(a,b));
    const [c,d]=snapshots('task-b','A shared twenty character prefix: two');
    miner.ingestTaskRefinements(c.clientId,c.taskId,c,d,authority(c,d,'event-b'));
    expect(miner.getCandidateRules('client-a').filter(r=>r.category==='copy_token')).toHaveLength(2);
  });
  it('describes the actual25px edit rather than inventing a40px platform rule', () => {
    const miner=new FeedbackMiner(),[a,b]=snapshots();
    const layout=miner.ingestTaskRefinements(a.clientId,a.taskId,a,b,authority(a,b)).find(r=>r.category==='layout')!;
    expect(layout.ruleText).toContain('25px');expect(layout.ruleText).not.toContain('40px');
    expect(layout.rationale).not.toMatch(/instagram|tiktok|kurdish/i);
  });
  it('projects text-only captures without invented geometry and rejects duplicate/incomplete geometry', () => {
    expect(refinementSnapshotFromManifest('client-a','task-a',{nodes:[{id:'text-one',type:'text',text:'Live text'}]}).layers)
      .toEqual([{id:'text-one',type:'text',text:'Live text'}]);
    for(const nodes of [
      [{id:'same',type:'text'},{id:'same',type:'text'}],
      [{id:'one',type:'text',x:0}], [{id:'one',type:'text',box:{x:0,y:0,width:-1,height:20}}],
    ]) expect(()=>refinementSnapshotFromManifest('client-a','task-a',{nodes})).toThrow(/MANIFEST_UNSUPPORTED/);
  });
});
