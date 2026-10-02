/** References only: Core resolves the immutable brief and the live customer grant. ADR-260. */
export interface CustomerOpenCommand {
  v: 1; requestId: string; tenantId: string; accountId: string; commandId: string; key: string;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isCustomerOpenCommand(value:unknown):value is CustomerOpenCommand {
  if(!value || typeof value!=='object') return false;
  const o=value as Record<string,unknown>;
  return o.v===1 && ['requestId','tenantId','accountId','commandId'].every(k=>typeof o[k]==='string' && UUID.test(o[k] as string))
    && typeof o.key==='string' && o.key.startsWith(`customer:${o.accountId}:`) && o.key.length<=220
    && /^[A-Za-z0-9:_-]+$/.test(o.key);
}
