import {learningReceiptKey,learningContentKey,resolveLearningExamples,type LearningExampleReceipt} from '@hawa/domain/feedback';
export type LearningEvidence=ReturnType<typeof resolveLearningExamples>;
/** Refuse malformed/foreign receipt sets instead of presenting guessed approval counts. */
export function learningEvidenceFromCore(clientId:string,value:unknown):LearningEvidence|null {
  try {
    if(!Array.isArray(value)) return null;
    return resolveLearningExamples(clientId,value as LearningExampleReceipt[]);
  } catch {return null;}
}
export function LearningEvidencePanel({evidence}:{evidence:LearningEvidence|null|undefined}) {
  if(!evidence) return <p style={{fontSize:11}}>Reviewed-design evidence unavailable.</p>;
  const positive=new Set(evidence.positiveExamples.map(learningReceiptKey));
  const negative=new Set(evidence.negativeExamples.map(learningReceiptKey));
  const targetKey=(receipt:LearningExampleReceipt)=>JSON.stringify([receipt.taskId,learningContentKey(receipt.target)]);
  const positiveTargets=new Set(evidence.positiveExamples.map(targetKey));
  const negativeTargets=new Set(evidence.negativeExamples.filter(r=>r.target.kind!=='task').map(targetKey));
  const taskHolds=new Set(evidence.negativeExamples.filter(r=>r.target.kind==='task').map(r=>r.taskId));
  return <details style={{fontSize:11,marginTop:8}}>
    <summary>Reviewed designs: {positiveTargets.size} positive · {negativeTargets.size} negative · {taskHolds.size} task holds · {evidence.receipts.length} receipts</summary>
    <p>Ratings are observations. Identical rejected content stays held under another design ID. Rule promotion and final design approval are separate decisions.</p>
    <ul>{evidence.receipts.map(receipt=>{
      const key=learningReceiptKey(receipt),target=receipt.target;
      return <li key={key} style={{marginBottom:8,overflowWrap:'anywhere'}}>
        <b>{negative.has(key)?'Negative':positive.has(key)?'Positive':'Observation / held approval'}</b>: {receipt.verdict}
        {receipt.rating!=null?` · rating ${receipt.rating}/10`:''}
        <div>Task: {receipt.taskId}</div>
        <div>{target.kind==='studio_candidate'?`Candidate: ${target.candidateId} · run: ${target.runId} · preview SHA256: ${target.previewSha256}`:
          target.kind==='design_revision'?`Revision: ${target.revisionId} · source SHA256: ${target.sourceSha256}`:receipt.basis==='unresolved_legacy'?'Historical feedback without a reviewed-design identity; conservative task hold':'Explicit task-wide hold'}</div>
        <div>Source: {receipt.feedbackId} · {receipt.basis} · {receipt.recordedAt}</div>
        <div>Recorded by: {receipt.actor.id} · role: {receipt.actor.role ?? 'unknown'}</div>
        {receipt.approval && <div>Approval: {receipt.approval.id} · decided by: {receipt.approval.actorId}</div>}
      </li>;
    })}</ul>
  </details>;
}
