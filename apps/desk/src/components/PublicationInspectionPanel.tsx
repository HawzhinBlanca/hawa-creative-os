import { useEffect, useRef, useState } from 'react';
import { parsePublicationInspectionState, type PublicationInspectionState, type PublicationInspectionCode } from '@hawa/contracts';
import { apiClient } from '../api/client.js';
import { reasonOf } from '../services/statusReport.js';

const findingLabel: Record<PublicationInspectionCode,string> = {
  ORIGINAL_INPUT_UNAVAILABLE: 'Original publication inputs are unavailable. Review the historical archive before retrying.',
  DRIVE_ID_UNRESERVED: 'No durable Drive file identity was recorded. Reconcile the original archive.',
  DRIVE_READ_UNAVAILABLE: 'The Drive item could not be verified. Check access before assuming it was deleted.',
  DRIVE_METADATA_CHANGED: 'Drive metadata differs from the approved publication. Inspect its name, folder, type and size.',
  DRIVE_CHECKSUM_UNAVAILABLE: 'Google did not provide a usable content checksum.',
  DRIVE_CHECKSUM_CHANGED: 'File contents differ from the approved export. Review the original and current file.',
  DRIVE_DUPLICATES_FOUND: 'An additional file has this publication identity. Review the duplicates before changing anything.',
  DRIVE_DUPLICATES_UNVERIFIED: 'The duplicate-file search could not be completed.',
  PERMISSIONS_BASELINE_UNAVAILABLE: 'The approved access policy has not been established. This read cannot certify permissions.',
  PERMISSIONS_READ_UNAVAILABLE: 'The complete permission list could not be verified.',
  PERMISSIONS_CHANGED: 'Permissions differ from the reference observation. Review who should have access.',
  SHEET_EXPECTATION_UNAVAILABLE: 'The original reporting row has not been bound. Reconcile the publication before retrying.',
  SHEET_READ_UNAVAILABLE: 'The reporting row could not be verified. Check access and row identity.',
  SHEET_ROW_CHANGED: 'The reporting row or its identity differs from the saved publication. Inspect it before repair.',
};

export function PublicationInspectionPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state,setState] = useState<PublicationInspectionState|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const sequence = useRef(0), cursor = useRef<string|undefined>(undefined);
  const load = async (after?: string) => {
    cursor.current = after; const epoch = ++sequence.current; setBusy(true); setError('');
    try {
      const result = parsePublicationInspectionState(await apiClient.operations.publicationInspections(after));
      if (!result) throw new Error('Incomplete or unsupported Google inspection evidence');
      if (epoch === sequence.current) setState(result);
    } catch (err) { if (epoch === sequence.current) { setState(null); setError(reasonOf(err)); } }
    finally { if (epoch === sequence.current) setBusy(false); }
  };
  useEffect(() => {
    void load(); const timer = setInterval(() => { void load(cursor.current); },60_000);
    return () => { clearInterval(timer); sequence.current++; };
  },[refreshKey]);
  return <section className="panel" aria-label="Google publication checks" style={{padding:16,marginTop:16}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap',alignItems:'center'}}>
      <h2 style={{margin:0}}>Google publication checks</h2>
      <button className="btn" onClick={() => void load(cursor.current)} disabled={busy}>Reload Google checks</button>
    </div>
    <p>Independent reads of Drive files, permissions and reporting rows, compared with the original publication. Checks do not publish, repair or send anything.</p>
    {error ? <p role="alert">Google inspection evidence unavailable: {error}</p> : !state ? <p>Reading stored inspection evidence…</p> : <>
      <p>{state.schedule.enabled ? 'Hourly checks are enabled; unfinished new publications wait 15 minutes before inspection.' : 'Scheduled checks are disabled in this app instance.'}</p>
      {state.items.length === 0 ? <p>No current publications are visible in your authorized client scope.</p> : state.items.map(item =>
        <article key={item.publicationId} style={{borderTop:'1px solid var(--border)',paddingTop:12,marginTop:12,overflowWrap:'anywhere'}}>
          <h3 style={{margin:'0 0 8px'}}>Task {item.taskId}</h3>
          <p><strong>{item.status === 'divergent' ? 'Differences need review' : item.status === 'consistent' ? 'Matched at last check' : 'Verification incomplete'}</strong>
            {' · '}{item.state === 'uninspected' ? 'No check recorded' : item.state === 'running' ? 'Check in progress' : item.state === 'interrupted' ? 'Previous check interrupted' : item.state === 'superseded' ? 'Historical result' : `${item.checkedFiles} file(s) read`}
            {item.finishedAt ? ` · ${new Date(item.finishedAt).toLocaleString()}` : ''}{item.stale && item.finishedAt ? ' · Observation is out of date' : ''}</p>
          {item.findings.length > 0 && <ul>{item.findings.slice(0,12).map((finding,i) => <li key={`${finding.code}-${i}`}>
            {findingLabel[finding.code]}{finding.resourceId && finding.resource !== 'publication' && <>
              {' '}<a href={`https://drive.google.com/open?id=${encodeURIComponent(finding.resourceId)}`} target="_blank" rel="noreferrer">Open {finding.resource}</a>
            </>}
          </li>)}</ul>}
          {item.findings.length > 12 && <details><summary>Show {item.findings.length - 12} more findings</summary><ul>
            {item.findings.slice(12).map((finding,i) => <li key={`${finding.code}-${i}`}>
              {findingLabel[finding.code]}{finding.resourceId && finding.resource !== 'publication' && <>
                {' '}<a href={`https://drive.google.com/open?id=${encodeURIComponent(finding.resourceId)}`} target="_blank" rel="noreferrer">Open {finding.resource}</a>
              </>}
            </li>)}
          </ul></details>}
          {item.inputsSha256 && <details><summary>Stored evidence identity</summary><p>Inspection: {item.inspectionId}</p><p>Inputs: {item.inputsSha256}</p><p>Result: {item.resultSha256 || 'Not yet recorded'}</p></details>}
        </article>)}
      <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:12}}>
        {cursor.current && <button className="btn" disabled={busy} onClick={() => void load()}>First publications</button>}
        {state.nextAfter && <button className="btn" disabled={busy} onClick={() => void load(state.nextAfter!)}>Next publications</button>}
      </div>
    </>}
  </section>;
}
