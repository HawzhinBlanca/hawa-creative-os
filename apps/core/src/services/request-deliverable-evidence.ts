import { MAX_REQUEST_DELIVERABLES } from '@hawa/domain';

/** Validate saved Core policy outside the untrusted workflow draft. */
export function parseDeliverableEvidence(value: {requestId:string;siblings?:Array<{requestId:string}>;
  deliverableCount?:unknown;deliverableDetailsRequired?:unknown}): {deliverableCount?:number;deliverableDetailsRequired?:string[]} {
  if (value.deliverableCount===undefined && value.deliverableDetailsRequired===undefined) return {};
  const ids=[value.requestId,...(value.siblings??[]).map(s=>s.requestId)];
  const details=value.deliverableDetailsRequired;
  if (!Number.isInteger(value.deliverableCount) || value.deliverableCount!==ids.length || ids.length<2 ||
      ids.length>MAX_REQUEST_DELIVERABLES || new Set(ids).size!==ids.length || !Array.isArray(details) ||
      details.some(id=>typeof id!=='string'||!ids.includes(id)) || new Set(details).size!==details.length)
    throw new Error('Invalid Core deliverable evidence');
  return {deliverableCount:ids.length,deliverableDetailsRequired:details};
}

