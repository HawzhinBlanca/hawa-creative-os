import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeEditableTransfer, type EditableTransferPlan } from '../../../packages/creative/src/editable-transfer.ts';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=fileURLToPath(new URL('.',import.meta.url));
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const source=readFileSync(root+'evals/rtl_golden_cases.jsonl');
const cases=source.toString().trim().split('\n').map(line=>JSON.parse(line));
if(cases.length!==40||new Set(cases.map(c=>c.id)).size!==40)throw new Error('Golden corpus changed');
const manifestPath=out+'fixtures.json';
if(existsSync(manifestPath))throw new Error('Existing frozen fixtures must be reused, not regenerated');
mkdirSync(out,{recursive:true});
const groups=[];
for(let index=0;index<4;index++){
 const selected=cases.slice(index*10,index*10+10);
 const plan:EditableTransferPlan={width:1200,height:2000,background:'#F6F8FC',
  text:selected.map((c,i)=>({copyIndex:i,x:80,y:60+i*190,width:1040,height:174,
   fontSize:32,fontFamily:'Noto Sans Arabic',color:'#14253D',
   align:c.expected_base_direction==='rtl'?'right':'left',rtl:c.expected_base_direction==='rtl',lineHeight:1.35})),
  shapes:selected.slice(0,-1).map((_,i)=>({x:80,y:242+i*190,width:1040,height:1,color:'#C6CDDA',kind:'line',strokeWidth:1}))};
 const encoded=await encodeEditableTransfer(plan,selected.map(c=>c.text),undefined,{extraFonts:['Noto Sans Arabic']});
 const id=`group-${index+1}`;const file=`${id}-input.pptx`;
 writeFileSync(out+file,encoded.bytes);
 groups.push({id,file,sha256:encoded.sha256,bytes:encoded.bytes.length,cases:selected,manifest:encoded.manifest,
  covered:'Exact supplied strings through the current encoder, real Canva import and final exports with explicit expected base direction.',
  notCovered:['Automatic direction inference','Native speaker glyph/joining/order review','Manual typing/edit/save','Multiple approved fonts','Narrow layouts',...(selected.some(c=>c.checks.includes('styled_runs'))?['Styled-run markup is literal exact input; actual style-boundary behavior is not tested.']:[])]});
}
const manifest={schemaVersion:1,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 corpus:{path:'evals/rtl_golden_cases.jsonl',sha256:digest(source),caseCount:40},sourceHashes:Object.fromEntries([
 'packages/creative/src/editable-transfer.ts','packages/qa/src/canva-pptx-check.ts','packages/integrations/src/canva-connect-client.ts','apps/core/src/services/canva-connect-service.ts'
 ].map(p=>[p,digest(readFileSync(root+p))])),groups,
 fullMultilingualAdmission:false,reason:'Forty synthetic strings grouped into four one-page sheets; native-language and real office cases remain required.'};
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({groups:groups.length,caseCount:40,sourceCommit:manifest.sourceCommit,sourceHash:manifest.corpus.sha256,realProviderCalls:0}));
