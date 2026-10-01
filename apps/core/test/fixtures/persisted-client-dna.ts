import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {createAppWithClientFixtures} from './app-with-client-fixtures.js';
/** Explicitly save test DNA through Core; process fixtures alone are not database authority. */
export async function persistClientDnaFixture(app:{request:(path:string,init?:RequestInit)=>Response|Promise<Response>},
 clientId:string,headers:Record<string,string>,layoutRules?:string[],fixtureClientId=clientId) {
 const source=createAppWithClientFixtures({testAuth:{principal:{role:'operator'}},skipPaidModelProbe:true,skipTelegramProbe:true,enableBillingProbeSchedule:false,enableCanvaSweeper:false});
 const read=await source.request(`/v1/clients/${fixtureClientId}/dna`,{headers});expect(read.status).toBe(200);
 const dna=await read.json();
 // A real hash must not equal the legacy generator's hard-coded placeholder.
 if(fixtureClientId==='client-office-1') for(const asset of dna.assets) {
  if(asset.role==='logo_primary') asset.sha256=createHash('sha256').update('Official Hawa fixture logo bytes').digest('hex');
 }
 if(layoutRules) dna.guidelines.layoutRules=layoutRules;
 const saved=await app.request(`/v1/clients/${clientId}/dna`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(dna)});
 expect([200,201]).toContain(saved.status);
 return dna;
}
