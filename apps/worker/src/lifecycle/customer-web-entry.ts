import { createHmac, timingSafeEqual } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import { isCustomerOpenCommand, type CustomerOpenCommand } from '@hawa/contracts';
import { acceptedWorkerSecrets } from './worker-secrets.js';
import type { CoreInternal } from './delivery.js';
import type { OpenAutomaticEvent } from './request-lifecycle.js';
const DEFAULT_TENANT_ID='00000000-0000-4000-a000-000000000001';
export interface SignedCustomerOpenCommand extends CustomerOpenCommand { signature:string }
function commandBytes(c:CustomerOpenCommand):string {
  return JSON.stringify(['hawa.customer.web.open.v1',c.v,c.requestId,c.tenantId,c.accountId,c.commandId,c.key]);
}
export function signCustomerOpenCommand(c:CustomerOpenCommand,secret:string):SignedCustomerOpenCommand {
  if(!isCustomerOpenCommand(c) || c.tenantId!==DEFAULT_TENANT_ID) throw new Error('INVALID_CUSTOMER_OPEN_COMMAND');
  if(!secret?.trim()) throw new Error('CUSTOMER_SIGNING_SECRET_NOT_CONFIGURED');
  return {...c,signature:createHmac('sha256',secret.trim()).update(commandBytes(c)).digest('hex')};
}
export interface CustomerWebEntryContext {
  key:string;
  run<T>(name:string,action:()=>Promise<T>):Promise<T>;
  sendOpen(requestId:string,event:OpenAutomaticEvent):Promise<void>;
}
export async function openCustomerWebRequest(ctx:CustomerWebEntryContext,core:CoreInternal,input:unknown,
  secrets:string[]=acceptedWorkerSecrets()):Promise<{requestId:string;forwarded:true}> {
  const c=input as Partial<SignedCustomerOpenCommand> | null;
  const signature=c?.signature;
  if(!isCustomerOpenCommand(c) || c.tenantId!==DEFAULT_TENANT_ID || ctx.key!==`web:${c.accountId}` ||
    typeof signature!=='string' || !/^[0-9a-f]{64}$/.test(signature) || Buffer.byteLength(JSON.stringify(c))>2048 ||
    !secrets.some(secret=>secret && timingSafeEqual(Buffer.from(signature,'hex'),createHmac('sha256',secret).update(commandBytes(c)).digest())))
    throw new restate.TerminalError('Invalid signed customer command',{errorCode:403});
  const refs:CustomerOpenCommand={v:1,requestId:c.requestId,tenantId:c.tenantId,accountId:c.accountId,commandId:c.commandId,key:c.key};
  const event=await ctx.run('customer-open-evidence',()=>core.post<OpenAutomaticEvent>(`/internal/customer/${c.requestId}/open-event`,refs));
  if(event?.v!==1 || event.requestId!==c.requestId || event.tenantId!==c.tenantId || event.chatId!==ctx.key ||
    event.eventId!==`open:${c.requestId}` || event.draft?.platform!=='hawzhin_web' || event.draft.sourceChannelId!==ctx.key)
    throw new restate.TerminalError('Customer open evidence has different scope',{errorCode:409});
  await ctx.sendOpen(c.requestId,event);
  return {requestId:c.requestId,forwarded:true};
}
