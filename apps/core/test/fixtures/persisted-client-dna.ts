import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {seedClientDnaFixtures} from './client-dna-fixtures.js';
import {computeDnaHash} from '../../src/app.js';
export function clientDnaFixture(clientId:string) {
 const fixtures:Parameters<typeof seedClientDnaFixtures>[0]=new Map();
 seedClientDnaFixtures(fixtures,new Map(),computeDnaHash);
 const source=fixtures.get(clientId);expect(source).toBeDefined();
 return structuredClone(source!);
}
/** Explicitly save test DNA through Core; process fixtures alone are not database authority. */
export async function persistClientDnaFixture(app:{request:(path:string,init?:RequestInit)=>Response|Promise<Response>},
 clientId:string,headers:Record<string,string>,layoutRules?:string[],fixtureClientId=clientId) {
 const dna=clientDnaFixture(fixtureClientId);
 // A real hash must not equal the legacy generator's hard-coded placeholder.
 if(fixtureClientId==='client-office-1') for(const asset of dna.assets) {
  if(asset.role==='logo_primary') asset.sha256=createHash('sha256').update('Official Hawa fixture logo bytes').digest('hex');
 }
 if(layoutRules) dna.guidelines.layoutRules=layoutRules;
 const saved=await app.request(`/v1/clients/${clientId}/dna`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(dna)});
 expect([200,201]).toContain(saved.status);
 return dna;
}
