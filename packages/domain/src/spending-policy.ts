import type { SpendingLimits, SpendingPolicyChange, SpendingRole } from '@hawa/contracts';

export const SPENDING_ROLES: readonly SpendingRole[] = ['creative_director','visual_judge','asset_photoreal',
  'intake_router','brief_builder','feedback_classifier','rule_miner','embedding_multimodal','reranker_multimodal','voice_transcriber'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
export const isSpendingUsd = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 &&
  v <= 1_000_000 && Math.round(v * 1_000_000) / 1_000_000 === v;

/** Pure validation and canonical ordering; no HTTP, storage or provider behavior. */
export function parseSpendingPolicyChange(value: unknown): SpendingPolicyChange | null {
  if (!object(value) || !exact(value,['expectedVersion','expectedLimitsSha256','reason','limits']) ||
    !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 || Number(value.expectedVersion) >= 2147483647 ||
    typeof value.expectedLimitsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedLimitsSha256) ||
    typeof value.reason !== 'string' || !value.reason.trim() || value.reason.trim().length > 500) return null;
  const l = value.limits;
  if (!object(l) || !exact(l,['officeUsd','clientUsd','roleUsd','clients','roles']) ||
    !isSpendingUsd(l.officeUsd) || !isSpendingUsd(l.clientUsd) || !isSpendingUsd(l.roleUsd) || !object(l.clients) || !object(l.roles) ||
    Object.keys(l.clients).length > 1000) return null;
  for (const [k,v] of Object.entries(l.clients))
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(k) || !isSpendingUsd(v)) return null;
  for (const [k,v] of Object.entries(l.roles)) if (!SPENDING_ROLES.includes(k as SpendingRole) || !isSpendingUsd(v)) return null;
  return { expectedVersion: Number(value.expectedVersion), expectedLimitsSha256: value.expectedLimitsSha256, reason: value.reason.trim(),
    limits: { officeUsd:l.officeUsd, clientUsd:l.clientUsd, roleUsd:l.roleUsd,
      clients:Object.fromEntries(Object.entries(l.clients).sort(([a],[b])=>a.localeCompare(b))) as Record<string,number>,
      roles:Object.fromEntries(Object.entries(l.roles).sort(([a],[b])=>a.localeCompare(b))) as SpendingLimits['roles'] } };
}

export function spendingPolicyChanges(before: SpendingLimits, after: SpendingLimits): Array<{scope:string;before:string;after:string}> {
  const changes: Array<{scope:string;before:string;after:string}> = [];
  const usd = (n:number) => `$${n.toFixed(6)}`;
  for (const [key,label] of [['officeUsd','Office daily limit'],['clientUsd','Default client daily limit'],['roleUsd','Default role daily limit']] as const)
    if (before[key] !== after[key]) changes.push({scope:label,before:usd(before[key]),after:usd(after[key])});
  for (const kind of ['clients','roles'] as const) {
    const a = before[kind] as Record<string,number>, b = after[kind] as Record<string,number>;
    for (const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()) {
      if (a[key] === b[key]) continue;
      const fallback = kind === 'clients' ? 'clientUsd' : 'roleUsd';
      changes.push({scope:`${kind === 'clients' ? 'Client' : 'Role'}: ${key}`,before:a[key] === undefined ? `Default ${usd(before[fallback])}` : usd(a[key]),
        after:b[key] === undefined ? `Default ${usd(after[fallback])}` : usd(b[key])});
    }
  }
  return changes;
}
