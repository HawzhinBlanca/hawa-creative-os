/** Offline only. No real database, provider, file mutation or live app access. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const root = new URL('../../../', import.meta.url);
delete process.env.DATABASE_URL;
process.env.NODE_ENV = 'test'; process.env.VITEST = 'true';
const operatorFixture = randomUUID();
const administratorFixture = randomUUID();
process.env.HAWA_BEARER_TOKEN = operatorFixture;
process.env.HAWA_ADMIN_KEY = administratorFixture;
process.env.HAWA_ACTION_HMAC_SECRET = randomUUID();
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('No network allowed'); };
const { createApp } = await import(new URL('apps/core/src/app.ts', root).href);
const { registerSystemRoutes } = await import(new URL('apps/core/src/routes/system.routes.ts', root).href);
const { DesignStudioService } = await import(new URL('apps/core/src/services/design-studio/design-studio-service.ts', root).href);
const headers = { Authorization: `Bearer ${operatorFixture}`, 'Content-Type': 'application/json', 'x-enforce-auth': '1' };
const adminHeaders = { ...headers, Authorization: `Bearer ${administratorFixture}` };
let dbTransactions = 0;
const lookupCodes: string[] = [];
const builder: any = new Proxy({}, {get(_o, key) {
  if (key === 'executeTakeFirst') return async () => undefined;
  if (key === 'where') return (field: string, _op: string, value: string) => { if (field === 'code') lookupCodes.push(value); return builder; };
  return () => builder;
}});
const fakeDb: any = {
  selectFrom: () => builder,
  transaction: () => ({ execute: async () => { dbTransactions++; throw new Error('Injected transaction refusal'); } }),
};
const dbApp = createApp({ db: fakeDb });
const original: any = await (await dbApp.request('/v1/clients/client-drustee/dna', {headers})).json();
const written = await dbApp.request('/v1/clients/client-drustee/dna', { method: 'POST', headers,
  body: JSON.stringify({...original, name:'Offline unsaved change',createdBy:'forged-author'}) });
const snap: any = await (await dbApp.request('/v1/clients/client-drustee/snapshots', {headers})).json();
const alias = { evidence: 'real HTTP handlers, fake DB returning no client', status:written.status, lookupCodes,
  attemptedDbTransactions:dbTransactions, snapshotAuthor:snap[0]?.createdBy, forgedAuthorRejected:snap[0]?.createdBy!=='forged-author' };

const app=createApp();
const rollback=await app.request('/v1/clients/client-drustee/dna/rollback',{method:'POST',headers,
  body:JSON.stringify({targetVersion:1, role:'administrator', reason:'Offline role escalation probe'})});
const rollbackJson: any=await rollback.json();
const rollbackResult={status:rollback.status,authenticatedRole:'operator',claimedBodyRole:'administrator',rolledBack:rollbackJson.rolledBack,snapshotAuthor:rollbackJson.snapshot?.createdBy};
const proposal=await app.request('/v1/clients/client-drustee/candidate-rules/propose',{method:'POST',headers,
  body:JSON.stringify({taskId:'offline-fixture-task',title:'Offline scope probe',category:'layout',ruleText:'OFFLINE_RULE_ONLY_FOR_DRUSTEE',rationale:'Probe only'})});
const prop: any=await proposal.json();
const promoted=await app.request(`/v1/clients/client-aster/candidate-rules/${prop.proposal.id}/promote`,{method:'POST',headers:adminHeaders,body:'{}'});
const aster:any=await (await app.request('/v1/clients/client-aster/dna',{headers})).json();
const governance={proposalStatus:proposal.status,originalRuleClient:prop.proposal.clientId,promotionUrlClient:'client-aster',promotionStatus:promoted.status,
  unrelatedClientReceivedRule:aster.guidelines.layoutRules.includes('OFFLINE_RULE_ONLY_FOR_DRUSTEE')};


const beforeFailedPromotion:any=await (await dbApp.request('/v1/clients/client-drustee/dna',{headers})).json();
const sameClientRejected=await dbApp.request(`/v1/clients/client-drustee/candidate-rules/${prop.proposal.id}/promote`,{method:'POST',headers:adminHeaders,body:'{}'});
const afterFailedPromotion:any=await (await dbApp.request('/v1/clients/client-drustee/dna',{headers})).json();
console.log(JSON.stringify({scenario:'Same-client promotion with authoritative DB client missing',status:sameClientRejected.status,rulePresentBefore:beforeFailedPromotion.guidelines.layoutRules.includes('OFFLINE_RULE_ONLY_FOR_DRUSTEE'),rulePresentAfter:afterFailedPromotion.guidelines.layoutRules.includes('OFFLINE_RULE_ONLY_FOR_DRUSTEE'),networkAttempts},null,2));
