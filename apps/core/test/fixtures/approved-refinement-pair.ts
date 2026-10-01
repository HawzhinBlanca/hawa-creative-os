import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { memoryExportStore } from '../pinned-exports-fixture.js';

/** Real isolated HTTP/repository authority flow; exported bytes remain an explicit test double. */
export async function approvedRefinementPair(app:{request:(path:string,init?:RequestInit)=>Response|Promise<Response>},
  headers:Record<string,string>,clientId:string,exports:ReturnType<typeof memoryExportStore>) {
  const taskResponse=await app.request('/v1/tasks',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},
    body:JSON.stringify({title:'[TEST] Approved refinement evidence',clientId})});
  expect(taskResponse.status).toBe(201);const task=await taskResponse.json();
  const revision=async(text:string)=>{
    const response=await app.request(`/v1/tasks/${task.id}/revisions`,{method:'POST',headers,
      body:JSON.stringify({nodes:[{id:'title',type:'text',text}]})});
    expect(response.status).toBe(201);return response.json();
  };
  const before=await revision('Initial recorded wording');
  const after=await revision('Reviewed recorded wording');
  const qa=await app.request(`/v1/tasks/${task.id}/revisions/${after.id}/qa`,{method:'POST',headers});
  expect(qa.status).toBe(200);expect((await qa.json()).criticalPass).toBe(true);
  const decision=await app.request(`/v1/tasks/${task.id}/revisions/${after.id}/decisions`,{method:'POST',headers,
    body:JSON.stringify({action:'approve',reason:'Isolated authority fixture review',pinnedExportIds:[exports.add(task.id)]})});
  expect(decision.status).toBe(201);
  return {taskId:task.id,clientId,beforeRevisionId:before.id,afterRevisionId:after.id};
}
