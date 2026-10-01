import { createHash } from 'node:crypto';
import { planRequestDeliverables, requestedDeliverableVariant, type RequestDeliverable } from '@hawa/domain';
import { matchRequestClient, positiveClientWords } from './client-packs.js';
import { splitBilingualRequest } from './chat-intake.js';

function requestIdForUpdate(chatId: string, updateId: number): string {
  const bytes = Buffer.from(createHash('sha256').update(`telegram-new-brief:${chatId}:${updateId}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The request a bilingual brief opens for its second language (ADR-139), as stable as the first's. */
function languageRequestIdFor(chatId: string, updateId: number, lang: 'ckb'): string {
  const bytes = Buffer.from(createHash('sha256').update(`telegram-new-brief:${chatId}:${updateId}:${lang}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Core application policy: bind source-derived deliverables before any retrieval or task effect. */
export function planLifecycleBriefDeliverables(briefText:string,input:{chatId:string;updateId:number;instructionOnly:boolean;acceptsLanguageSiblings:boolean}) {
  const {chatId,updateId,instructionOnly,acceptsLanguageSiblings}=input;
  const requestId=requestIdForUpdate(chatId,updateId);
  const allocation = planRequestDeliverables(briefText);
  type Part = {requestId:string;text:string;lang?:'en'|'ckb';variant?:{width:number;height:number};detailsRequired?:true;clientId?:string};
  const parts:Part[]=[];
  if (allocation.kind === 'limit') return {requestId,allocation,parts};
  const shared = allocation.kind === 'multiple' ? allocation.shared : '';
  const items:RequestDeliverable[] = allocation.kind === 'multiple' ? allocation.parts : [{text:briefText}];
  for (const item of items) {
    const ownClient = allocation.kind==='multiple' ? matchRequestClient({rawText:positiveClientWords(item.text)}) : {kind:'none' as const};
    const sharedClient = matchRequestClient({rawText:positiveClientWords(shared)});
    const clientId = ownClient.kind === 'named' ? ownClient.pack.id :
      ownClient.kind !== 'ambiguous' && sharedClient.kind === 'named' ? sharedClient.pack.id : undefined;
    const detailsRequired = item.detailsRequired || ownClient.kind === 'ambiguous' ||
      (ownClient.kind==='none' && sharedClient.kind==='ambiguous');
    const words = allocation.kind === 'multiple'
      ? `${shared}\nThis request is one deliverable of ${allocation.count}. Produce only its copy below.\n_____\n${item.text || briefText}` : item.text;
    const bilingual = !instructionOnly && !detailsRequired && acceptsLanguageSiblings ? splitBilingualRequest(words) : null;
    for (const piece of bilingual ? [{text:bilingual.en,lang:'en' as const},{text:bilingual.ckb,lang:'ckb' as const}] : [{text:words}]) {
      const ordinal=parts.length;
      const id=ordinal===0 ? requestId : allocation.kind === 'single' && ordinal===1
        ? languageRequestIdFor(chatId,updateId,'ckb')
        : requestIdForUpdate(`${chatId}:deliverable:${ordinal+1}`,updateId);
      parts.push({requestId:id,...piece,variant:item.variant ?? requestedDeliverableVariant(item.text),
        ...(clientId ? {clientId} : {}),...(detailsRequired ? {detailsRequired:true} : {})});
    }
  }
  return {requestId,allocation,parts};
}
