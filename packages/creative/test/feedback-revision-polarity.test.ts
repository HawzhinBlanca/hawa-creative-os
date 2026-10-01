import {describe,it,expect} from 'vitest';
import {FeedbackMiner} from '../src/feedback-miner.js';
import {refinementSnapshotHash} from '../src/refinement-evidence.js';
const picture=(candidateId:string,hash='a'.repeat(64))=>({kind:'studio_candidate' as const,runId:'run-a',candidateId,previewSha256:hash});
const event=(id:string,verdict:'approve'|'reject'|'revise'|'rating',candidateId:string,rating?:number)=>({
  id,clientId:'client-a',taskId:'task-a',actorId:'reviewer-a',actorRole:'designer',verdict,rating,
  target:picture(candidateId),notes:'Keep deliberate title spacing',createdAt:'2026-10-01T00:00:00.000Z',
});
describe('Exact reviewed design polarity',()=>{
  it('rejects one picture without rejecting its task or another approved picture',()=>{
    const miner=new FeedbackMiner();miner.ingestDesignFeedback(event('reject-a','reject','candidate-a'));
    const accepted=miner.ingestDesignFeedback(event('approve-b','approve','candidate-b'))[0];
    expect(miner.isTaskRejected('task-a','client-a')).toBe(false);
    expect(accepted.examples).toMatchObject({positiveExampleTaskIds:['task-a'],positiveExamples:[{target:picture('candidate-b')}]});
  });
  it('does not convert a high rating into approval or validate another picture in the same task',()=>{
    const miner=new FeedbackMiner(),rule=miner.ingestDesignFeedback(event('rating-a','rating','candidate-a',9))[0];
    miner.ingestDesignFeedback({...event('other-approval','approve','candidate-b'),notes:null});
    expect(rule.examples.positiveExampleTaskIds).toEqual([]);
    miner.ingestDesignFeedback({...event('same-approval','approve','candidate-a'),notes:null});
    expect(rule.examples).toMatchObject({positiveExamples:[{target:picture('candidate-a'),feedbackId:'same-approval'}]});
  });
  it('keeps a rejected exact picture negative despite a later contradictory approval',()=>{
    const miner=new FeedbackMiner(),rule=miner.ingestDesignFeedback(event('reject-a','reject','candidate-a'))[0];
    miner.ingestDesignFeedback({...event('approve-a','approve','candidate-a'),notes:null});
    expect(rule.examples).toMatchObject({positiveExampleTaskIds:[],negativeExamples:[{target:picture('candidate-a')}]});
  });
  it('refuses changed picture identity under an existing feedback action',()=>{
    const miner=new FeedbackMiner(),input=event('action-a','approve','candidate-a');miner.ingestDesignFeedback(input);
    expect(()=>miner.ingestDesignFeedback({...input,target:picture('candidate-a','b'.repeat(64))})).toThrow(/reuse|conflict/i);
  });
  it('does not invent positive target evidence for unbound historical feedback',()=>{
    const {target,...legacy}=event('legacy-approval','approve','candidate-a');
    const rule=new FeedbackMiner().ingestDesignFeedback(legacy)[0];expect(rule.examples.positiveExampleTaskIds).toEqual([]);
  });
  it('allows a corrected approved revision after an earlier revision rejection',()=>{
    const miner=new FeedbackMiner();
    miner.ingestDesignFeedback({...event('rejected-revision','reject','unused'),target:{kind:'design_revision' as const,revisionId:'before',sourceSha256:'a'.repeat(64)}});
    const before={clientId:'client-a',taskId:'task-a',layers:[{id:'title',type:'text' as const,text:'Before'}]},after={...before,layers:[{id:'title',type:'text' as const,text:'After'}]};
    const rule=miner.ingestTaskRefinements('client-a','task-a',before,after,{feedbackId:'pair-a',clientId:'client-a',taskId:'task-a',
      beforeRevisionId:'before',afterRevisionId:'after',beforeSourceSha256:'a'.repeat(64),afterSourceSha256:'b'.repeat(64),
      beforeSnapshotSha256:refinementSnapshotHash(before),afterSnapshotSha256:refinementSnapshotHash(after),
      approvalId:'approval-a',approvedBy:'approver-a',actor:{id:'collector-a',role:'designer'}})[0];
    expect(rule.examples).toMatchObject({positiveExamples:[{target:{kind:'design_revision',revisionId:'after'},approval:{id:'approval-a',actorId:'approver-a'}}]});
    expect(rule.examples.positiveExampleTaskIds).toEqual(['task-a']);
  });
  it('refuses a malformed later receipt before admitting earlier batch evidence',()=>{
    const miner=new FeedbackMiner();
    expect(()=>miner.ingestDesignFeedback([event('valid','approve','candidate-a'),{...event('invalid','rating','candidate-b'),rating:11}])).toThrow(/invalid/i);
    expect(miner.getCandidateRules('client-a')).toEqual([]);
  });
  it('preserves a newly rejected target while a moderation snapshot is pending',()=>{
    const miner=new FeedbackMiner(),rule=miner.ingestDesignFeedback(event('approved','approve','candidate-a'))[0];
    const prepared=miner.prepareRulePromotion(rule.id,'art_director');
    expect(prepared.promoted).toBe(true);
    miner.ingestDesignFeedback({...event('negative','reject','candidate-a'),notes:null});
    miner.commitRulePromotion(prepared);
    expect(rule.status).toBe('PROMOTED');expect(rule.examples.positiveExamples).toEqual([]);
    expect(rule.examples.negativeExamples).toContainEqual(expect.objectContaining({feedbackId:'negative'}));
  });
  it('keeps receipts separate for a bounded 500-target corpus without a provider',()=>{
    const miner=new FeedbackMiner(),start=performance.now();
    for(let i=0;i<500;i++) miner.ingestDesignFeedback({...event(`rating-${i}`,'rating',`candidate-${i}`,9),taskId:`task-${i}`});
    for(let i=0;i<500;i++) miner.ingestDesignFeedback({...event(`approval-${i}`,'approve',`candidate-${i}`),taskId:`task-${i}`,notes:null});
    const rules=miner.getCandidateRules('client-a');expect(rules).toHaveLength(500);
    for(let i=0;i<500;i++) {
      expect(rules[i].examples.positiveExampleTaskIds).toEqual([`task-${i}`]);
      expect(rules[i].examples.receipts).toHaveLength(2);
    }
    console.info(JSON.stringify({study:'500 distinct reviewed targets and explicit approvals',elapsedMs:performance.now()-start,providerCalls:0}));
  });

});
