/** ADR-260: real isolated Restate transport, actual SDK objects, synthetic Core only; no providers. */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import * as restate from '@restatedev/restate-sdk';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';
import { signCustomerActionCommand } from '../src/lifecycle/customer-web-actions.js';
import { signCustomerOpenCommand } from '../src/lifecycle/customer-web-entry.js';
import type { OutboxCommandRecord } from '../src/outbox-consumer.js';

const ingress='http://127.0.0.1:55580',admin='http://127.0.0.1:55570';
const tenantId='00000000-0000-4000-a000-000000000001',accountId=randomUUID(),requestId=randomUUID(),taskId=randomUUID(),clientId=randomUUID();
const secret=['synthetic','isolated','customer','gateway','secret'].join('-');
process.env.HAWA_WORKER_TOKEN=secret;
process.env.HAWA_CORE_INTERNAL_URL='http://127.0.0.1:50881';
for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','TELEGRAM_BOT_TOKEN']) process.env[key]='';
const chatId=`web:${accountId}`,actionId=randomUUID(),actions=process.argv.includes('--actions');
let actionRefs:Record<string,unknown>|undefined;
const photos=process.argv.includes('--photos') ? {v:1,images:Array.from({length:6},(_,i)=>({sha256:String(i+1).repeat(64),mediaType:'image/png',size:i+100}))} : undefined;
const event={v:1,eventId:`open:${requestId}`,requestId,tenantId,chatId,
  draft:{platform:'hawzhin_web',sourceEventId:`lc-${requestId}-r0`,sourceChannelId:chatId,
    clientId,rawText:'Synthetic exact copy',title:'Synthetic test',autoGenerate:true,designStudio:true,...(photos ? {customerWebPhotos:photos} : {})}};
const calls:Array<{path:string;body:unknown}>=[];
const core=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.headers.authorization!==`Bearer ${secret}`){res.writeHead(403).end();return;}
  const body:unknown=JSON.parse(raw);calls.push({path:req.url!,body});
  const value=req.url===`/v1/internal/customer/${requestId}/open-event` ? event :
    req.url===`/v1/internal/lifecycle/${requestId}/project` ? {v:1,taskId,stage:'manual',rev:1,autoGenerate:false} :
    req.url===`/v1/internal/customer/actions/${actionId}/event` ? {...actionRefs,expectedRev:1,taskId,bodyHash:'1'.repeat(64),kind:'cancel'} :
    req.url===`/v1/internal/customer/actions/${actionId}/project` ? {v:1,actionId,requestId,kind:'cancel',accepted:true,taskId,rev:2,stage:'cancelled',fromStage:'manual'} :
    req.url===`/v1/internal/customer/actions/${actionId}/ack` ? {acknowledged:true} :
    req.url==='/v1/internal/customer/web-message' ? {outcome:'web_recorded',receiptId:randomUUID()} : null;
  res.writeHead(value?200:404,{'content-type':'application/json'}).end(JSON.stringify(value));
});
const {chatInbox}=await import('../src/lifecycle/chat-inbox.js');
const {RequestLifecycleApi}=await import('../src/lifecycle/request-lifecycle.js');
const {createTelegramSender,telegramSenderDepsFromEnv}=await import('../src/lifecycle/telegram-sender.js');
const endpoint=restate.endpoint().bind(chatInbox).bind(RequestLifecycleApi).bind(createTelegramSender(telegramSenderDepsFromEnv(undefined)));
const worker=createServer(endpoint.http1Handler());
const listen=(server:Server,port:number)=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
async function json(url:string,body:unknown,headers:Record<string,string>={}) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const answer:unknown=await response.json().catch(()=>null);return {status:response.status,answer};
}
try {
  await listen(core,50881);await listen(worker,50880);
  const registered=await json(`${admin}/deployments`,{uri:'http://host.docker.internal:50880',use_http_11:true,force:true});
  assert.ok(registered.status===201 || registered.status===200,JSON.stringify(registered));
  const privateResult=await json(`${ingress}/RequestLifecycle/${requestId}/open/send`,event);
  assert.ok(privateResult.status===400 && JSON.stringify(privateResult.answer).includes('not public'),JSON.stringify(privateResult));
  const cmd:OutboxCommandRecord={id:randomUUID(),tenant_id:tenantId,aggregate_id:requestId,aggregate_type:'request',
    command_type:'customer.request.open',idempotency_key:`customer:${accountId}:transport_001`,payload:{v:1,requestId,accountId},state:'leased',attempts:1};
  const dispatcher=new TaskWorkflowDispatcher({restateIngressUrl:ingress,customerSigningSecret:secret});
  const first=await dispatcher.dispatchCustomer(cmd),second=await new TaskWorkflowDispatcher({restateIngressUrl:ingress,customerSigningSecret:secret}).dispatchCustomer(cmd);
  assert.equal(first.receiptId,second.receiptId);
  const refs={v:1 as const,requestId,tenantId,accountId,commandId:cmd.id,key:cmd.idempotency_key};
  const completion=await json(`${ingress}/ChatInbox/${chatId}/webOpen`,signCustomerOpenCommand(refs,secret),{'Idempotency-Key':cmd.idempotency_key});
  assert.equal(completion.status,200,JSON.stringify(completion));
  for(let i=0;i<80 && !calls.some(c=>c.path==='/v1/internal/customer/web-message');i++)await new Promise(resolve=>setTimeout(resolve,100));
  const evidence=calls.filter(c=>c.path.endsWith('/open-event')),projection=calls.filter(c=>c.path.endsWith('/project')),messages=calls.filter(c=>c.path.endsWith('/web-message'));
  assert.equal(evidence.length,1);assert.deepEqual(evidence[0].body,refs);assert.equal(projection.length,1);assert.equal(messages.length,1);
  assert.deepEqual((projection[0].body as {ops:Array<{draft:unknown}>}).ops[0].draft,event.draft);
  const tampered=await json(`${ingress}/ChatInbox/${chatId}/webOpen`,{...signCustomerOpenCommand(refs,secret),commandId:randomUUID()});
  assert.equal(tampered.status,403,JSON.stringify(tampered));assert.equal(calls.length,3);
  let actionProof:unknown;
  if(actions) {
    const actionCmd:OutboxCommandRecord={...cmd,id:randomUUID(),command_type:'customer.request.action',
      idempotency_key:`customer:${accountId}:action:transport_action_001`,payload:{v:1,requestId,accountId,actionId}};
    const signedRefs={v:1 as const,requestId,tenantId,accountId,actionId,commandId:actionCmd.id,key:actionCmd.idempotency_key};
    actionRefs=signedRefs;
    const blocked=await json(`${ingress}/RequestLifecycle/${requestId}/customerAction/send`,{...signedRefs,expectedRev:1,taskId,bodyHash:'1'.repeat(64),kind:'cancel'});
    assert.equal(blocked.status,400,JSON.stringify(blocked));
    const accepted=await dispatcher.dispatchCustomer(actionCmd),replayed=await new TaskWorkflowDispatcher({restateIngressUrl:ingress,customerSigningSecret:secret}).dispatchCustomer(actionCmd);
    assert.equal(accepted.receiptId,replayed.receiptId);
    const completed=await json(`${ingress}/ChatInbox/${chatId}/webAction`,signCustomerActionCommand(signedRefs,secret),{'Idempotency-Key':actionCmd.idempotency_key});
    assert.equal(completed.status,200,JSON.stringify(completed));
    for(let i=0;i<100 && (!calls.some(c=>c.path.endsWith('/ack')) || calls.filter(c=>c.path.endsWith('/web-message')).length<2);i++)await new Promise(resolve=>setTimeout(resolve,100));
    const actionCalls=calls.filter(c=>c.path.includes(`/customer/actions/${actionId}/`));
    assert.deepEqual(actionCalls.map(c=>c.path.split('/').pop()),['event','project','ack']);
    assert.deepEqual(actionCalls[0].body,signedRefs);
    assert.deepEqual((actionCalls[1].body as {basis:unknown}).basis,{taskId,rev:1,stage:'manual',round:0});
    const notices=calls.filter(c=>c.path.endsWith('/web-message'));assert.equal(notices.length,2);
    assert.equal((notices[1].body as {text:string}).text,'Your design request was cancelled.');
    const invalid=await json(`${ingress}/ChatInbox/${chatId}/webAction`,{...signCustomerActionCommand(signedRefs,secret),actionId:randomUUID()});
    assert.equal(invalid.status,403,JSON.stringify(invalid));assert.equal(calls.length,7);
    actionProof={privateHandlerStatus:blocked.status,gatewayStatus:completed.status,invocationReceipt:accepted.receiptId,replayedReceipt:replayed.receiptId,
      evidenceReads:1,ownerProjections:1,appliedAcknowledgements:1,cancellationNotices:1,tamperedStatus:invalid.status};
  }
  const output={timestamp:new Date().toISOString(),success:true,mode:'isolated-real-Restate-1.7.10-synthetic-Core',
    privateLifecycleHttpStatus:privateResult.status,invocationReceipt:first.receiptId,replayedReceipt:second.receiptId,
    gatewayHttpStatus:completion.status,tamperedHttpStatus:tampered.status,coreEvidenceReads:evidence.length,
    lifecycleProjections:projection.length,durableWebMessages:messages.length,orderedPhotoReferences:photos?.images.length ?? 0,providersCalled:false,productionTouched:false,...(actionProof ? {actionProof} : {})};
  const outputDir='output/qualification/2026-10-02/'+(actions ? 'customer-actions' : photos ? 'customer-photos' : 'customer-boundary');
  mkdirSync(outputDir,{recursive:true});
  writeFileSync(outputDir+'/WEB_RESTATE_TRANSPORT.json',JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output));
} finally {await close(worker);await close(core);}
