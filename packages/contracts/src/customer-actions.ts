export type CustomerActionBody=
 | {kind:'cancel';expectedVersion:number;reason:string}
 | {kind:'seen';expectedVersion:number;messageId:string}
 | {kind:'answer';expectedVersion:number;messageId:string;directive:string;exactCopy?:CustomerActionCopy[]}
 | {kind:'revise';expectedVersion:number;directive:string;category:'layout'|'imagery'|'typography'|'copy'|'other';exactCopy?:CustomerActionCopy[]};
export interface CustomerActionCopy {text:string;language:'en'|'ar'|'ckb'}
export interface CustomerActionCommand {v:1;requestId:string;tenantId:string;accountId:string;commandId:string;actionId:string;key:string}
export interface CustomerActionEvent extends CustomerActionCommand {expectedRev:number;taskId:string;bodyHash:string;kind:CustomerActionBody['kind']}
export interface CustomerActionResult {
 v:1;actionId:string;requestId:string;kind:CustomerActionBody['kind'];accepted:boolean;code?:string;
 taskId?:string;rev?:number;stage?:string;round?:number;runId?:string;directive?:string;
 questionId?:string;messageId?:string;seenAtMs?:number;fromStage?:string;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isCustomerActionCommand(value:unknown):value is CustomerActionCommand {
 if(!value || typeof value!=='object')return false;
 const c=value as Record<string,unknown>;
 return c.v===1 && ['requestId','tenantId','accountId','commandId','actionId'].every(k=>typeof c[k]==='string' && UUID.test(c[k] as string))
 && typeof c.key==='string' && c.key.startsWith(`customer:${c.accountId}:action:`) && c.key.length<=240 && /^[A-Za-z0-9:_-]+$/.test(c.key);
}
export function isCustomerActionEvent(value:unknown):value is CustomerActionEvent {
 if(!isCustomerActionCommand(value))return false;
 const e=value as unknown as Record<string,unknown>;
 return typeof e.taskId==='string' && UUID.test(e.taskId) && Number.isSafeInteger(e.expectedRev) && Number(e.expectedRev)>0 &&
  typeof e.bodyHash==='string' && /^[a-f0-9]{64}$/.test(e.bodyHash) && ['revise','answer','seen','cancel'].includes(String(e.kind));
}
