import {randomUUID} from 'node:crypto';
import type {createApp} from '../../src/app.js';
import type {ReceiptAuditState} from '@hawa/contracts';
/** Real audit API preflight; fixture rows are never sent as operational evidence. */
export async function runReceiptAudit(app:ReturnType<typeof createApp>,headers:Record<string,string>={},extra:Record<string,unknown>={}) {
 const read=await app.request('/v1/operations/reconciliation',{headers});
 if(read.status!==200)throw new Error(`Audit preflight refused: ${read.status}`);
 const state=await read.json() as ReceiptAuditState,actionId=randomUUID();
 return app.request('/v1/operations/reconciliation/run',{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':actionId},
  body:JSON.stringify({actionId,expectedScopeSha256:state.scope.sha256,expectedLatestAuditId:state.latest?.auditId??null,reason:'Test stored publication receipts',...extra})});
}
