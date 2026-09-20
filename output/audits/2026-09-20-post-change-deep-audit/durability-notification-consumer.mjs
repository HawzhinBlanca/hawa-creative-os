// Actual consumer logic; dependency boundaries replaced with in-memory doubles. No DB/network.
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../../../apps/worker/src/outbox-consumer.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const stripped=compiled.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm,'');
const fixture={commands:[],decisions:[],response:{success:false,error:'TELEGRAM_RECEIPT_INVALID'},sends:0};
globalThis.__durabilityAudit=fixture;
const prelude=`
const fixture=globalThis.__durabilityAudit;
class OutboxRepository {
  async leasePending(){return fixture.commands.splice(0);}
  async markDelivered(){fixture.decisions.push('delivered');return {state:'delivered'};}
  async markUncertain(){fixture.decisions.push('uncertain');return {state:'failed',attempts:1};}
  async markPermanentFailure(){fixture.decisions.push('permanent');return {state:'failed',attempts:1};}
  async retryOrDeadLetter(){fixture.decisions.push('retry');return {state:'pending',attempts:1};}
}
class TaskRepository {};
class OfficeTracer {};
class TaskWorkflowDispatcher {};
class TelegramBridge {async dispatchOutboundMessage(){fixture.sends++;return fixture.response;}}
const withRlsContext=async(db,scope,fn)=>fn({});
`;
const {OutboxConsumer}=await import('data:text/javascript;base64,'+Buffer.from(prelude+stripped).toString('base64'));
process.env.TELEGRAM_BOT_TOKEN=crypto.randomUUID();
const command={id:'synthetic-command',tenant_id:'synthetic-tenant',aggregate_id:'synthetic-task',command_type:'notify.telegram',payload:{chatId:'synthetic-chat',message:{text:'synthetic-notification'}},state:'pending',attempts:0};
const consumer=new OutboxConsumer({},{});
fixture.commands.push({...command});const first=await consumer.processBatch();
fixture.commands.push({...command,attempts:1});const second=await consumer.processBatch();
console.log(JSON.stringify({head:'6d3c583791a404c914e25b77dda558b16d26bd6c',sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),scope:'actual production consumer classification/default handler with synthetic DB and TelegramBridge boundary',externalNetworkAccess:false,databaseAccess:false,scenario:'Bridge returns receipt invalid after provider HTTP200',sends:fixture.sends,decisions:fixture.decisions,first,second},null,2));
delete globalThis.__durabilityAudit;
