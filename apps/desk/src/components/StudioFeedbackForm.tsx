import { useState } from 'react';
import { isRenderedStudioCandidate } from '@hawa/domain/feedback';
import { apiClient } from '../api/client.js';

type Payload = Parameters<typeof apiClient.studio.feedback>[1];
type Action = { id: string; payload: Payload };
export function StudioFeedbackForm({taskId,runId,candidateId,previewSha256,previewAvailable=true}: {
  taskId:string; runId:string; candidateId:string; previewSha256?:string; previewAvailable?:boolean;
}) {
  const storageKey = `hawa.design-feedback.${taskId}.${runId}.${candidateId}`;
  const [recovery] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as Action | null;
      if (saved && (!saved.id || saved.payload?.runId !== runId || saved.payload?.candidateId !== candidateId)) {
        throw new Error('Saved feedback does not match this candidate.');
      }
      return { saved, error: '' };
    } catch { return {saved:null, error:'Saved feedback could not be read. Recover browser storage before submitting.'}; }
  });
  const [pending,setPending] = useState<Action | null>(recovery.saved);
  const [verdict,setVerdict] = useState<Payload['verdict'] | ''>(recovery.saved?.payload.verdict || '');
  const [rating,setRating] = useState<number | ''>(recovery.saved?.payload.rating || '');
  const [notes,setNotes] = useState(recovery.saved?.payload.notes || '');
  const [busy,setBusy] = useState(false), [recorded,setRecorded] = useState(false), [notice,setNotice] = useState(recovery.error);
  const rendered = previewAvailable && isRenderedStudioCandidate({previewSha256});
  const valid = rendered && Boolean(verdict) && Number.isInteger(rating) && Number(rating)>=1 && Number(rating)<=10;
  const submit = async () => {
    if (busy || recorded || recovery.error || (!pending && !valid)) return;
    const action = pending || {id:crypto.randomUUID(),payload:{runId,candidateId,previewSha256,
      verdict:verdict as Payload['verdict'],rating:Number(rating),notes:notes.trim() || undefined}};
    try {
      const bytes=JSON.stringify(action); sessionStorage.setItem(storageKey,bytes);
      if (sessionStorage.getItem(storageKey)!==bytes) throw new Error('Browser storage did not retain feedback.');
    } catch {setNotice('Feedback was not sent: browser storage could not retain the action.');return;}
    setPending(action);setBusy(true);setNotice('');
    try {
      await apiClient.studio.feedback(taskId,action.payload,action.id);
      setRecorded(true);setNotice('Feedback recorded. Final release requires a separate approval.');
      sessionStorage.removeItem(storageKey);setPending(null);
    } catch (error) {setNotice(`${error instanceof Error ? error.message : 'Feedback result unavailable'} Retry retains the original review.`);}
    finally {setBusy(false);}
  };
  return <section aria-label="Review this design" style={{marginTop:14,padding:12,background:'var(--soft)',borderRadius:6}}>
    <h4>Review this design</h4>
    <p>{rendered ? 'Choose your verdict and rating. Feedback does not approve final release.' : 'Feedback becomes available after this design has a rendered preview.'}</p>
    <fieldset disabled={!rendered || busy || recorded || Boolean(pending) || Boolean(recovery.error)} style={{border:0,padding:0}}>
      <legend>Design feedback</legend>
      <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{(['approve','revise','reject'] as const).map(value =>
        <label key={value}><input type="radio" name={`verdict-${candidateId}`} checked={verdict===value} onChange={()=>setVerdict(value)}/>{value}</label>)}</div>
      <label style={{display:'block',marginTop:8}}>Rating (1–10)<input type="number" min={1} max={10} step={1} value={rating}
        onChange={event=>setRating(event.target.value===''?'':Number(event.target.value))}/></label>
      <label style={{display:'block'}}>Feedback notes<textarea value={notes} maxLength={4000} placeholder="What works or needs changing?" onChange={event=>setNotes(event.target.value)}/></label>
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    <button className="btn" disabled={busy || recorded || Boolean(recovery.error) || (!pending && !valid)} onClick={()=>void submit()}>
      {recorded?'Recorded ✓':busy?'Recording…':pending?'Retry saved feedback':'Submit Feedback'}</button>
    {pending && !busy && <button className="btn" onClick={()=>{
      try {sessionStorage.removeItem(storageKey);setPending(null);setNotice('Local retry cleared. Any recorded feedback remains in server history.');}
      catch {setNotice('Browser storage could not clear the saved action.');}
    }}>Clear local retry</button>}
  </section>;
}
