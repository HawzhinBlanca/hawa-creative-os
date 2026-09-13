import React, { useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';
export const CanvaConnectionPanel: React.FC = () => {
  const [status,setStatus]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=async()=>{setError('');try{setStatus(await apiClient.canva.status());}catch(e:any){setStatus(null);setError(e.message);}};
  useEffect(()=>{void refresh();},[]);
  const connect=async()=>{setBusy(true);setError('');try{const result=await apiClient.canva.authorize();window.location.assign(result.authorizationUrl);}catch(e:any){setError(e.message);setBusy(false);}};
  const disconnect=async()=>{setBusy(true);try{const r=await apiClient.canva.disconnect();await refresh();setError(r.message||'Canva disconnected.');}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <section aria-label="Canva connection" className="rule">
    <h3>Connect your Canva account</h3>
    <p>{status?.authorized ? 'Account authorized. Each design and export is checked separately.' : status?.configured ? 'Server setup is ready. Connect your Canva account to create designs and retrieve exports.' : 'Server setup is required before Hawa can connect to Canva.'}</p>
    <p>Canva remains your editor. Retrieved exports still need design QA and human approval.</p>
    {status && !status.configured && <details><summary>Setup details</summary><p>Configure a Canva Developer integration, its callback address, and a secure token storage key on the Hawa server.</p><p>Missing: {(status.missing||[]).join(', ') || 'Configuration is invalid'}</p>{status.redirectUri && <p>Callback: {status.redirectUri}</p>}</details>}
    {error && <p role="alert">{error}</p>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      <button className="btn" disabled={busy||!status?.configured} onClick={connect}>{status?.authorized?'Reconnect Canva':'Connect Canva'}</button>
      {status?.authorized&&<button className="btn" disabled={busy} onClick={disconnect}>Disconnect Canva</button>}
      <button className="btn" onClick={refresh} disabled={busy}>Refresh connection</button>
    </div>
  </section>;
};
