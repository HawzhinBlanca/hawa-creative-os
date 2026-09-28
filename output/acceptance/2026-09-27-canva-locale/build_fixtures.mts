import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeEditableTransfer } from '../../../packages/creative/src/editable-transfer.ts';
import { encodeStudioTransferV2 } from '../../../packages/creative/src/studio/transfer-v2.ts';
import type { StudioLayoutV2 } from '../../../packages/creative/src/studio/layout-v2.ts';
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=fileURLToPath(new URL('.',import.meta.url));
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
if(existsSync(out+'fixtures.json'))throw new Error('Reuse frozen fixtures; do not regenerate');
const baseline=JSON.parse(readFileSync(root+'output/acceptance/2026-09-27-canva-multilingual/fixtures.json','utf8')).groups[0];
const groups=[];
const cases=baseline.cases.map((c:any)=>({...c,locale:['ckb','ar','en'].includes(c.language)?c.language:'und'}));
const first=await encodeEditableTransfer(baseline.manifest.plan,cases.map((c:any)=>c.text),undefined,{extraFonts:['Noto Sans Arabic'],copyLocales:cases.map((c:any)=>c.locale)});
writeFileSync(out+'locale-v1-input.pptx',first.bytes);
groups.push({id:'locale-v1',file:'locale-v1-input.pptx',bytes:first.bytes.length,sha256:first.sha256,cases,manifest:first.manifest,
 baseline:'output/acceptance/2026-09-27-canva-multilingual/group-1-round-2-canva.png',
 baselineSha256:digest(readFileSync(root+'output/acceptance/2026-09-27-canva-multilingual/group-1-round-2-canva.png')),
 scope:'Prior ten-string layout and exact strings, only import language tags changed.'});
const styled=[
 {id:'STYLE-AR',text:'مرحبا NOVA بالعالم\nالسعر الخاص: ٢٥٬٠٠٠ دينار',language:'ar',locale:'ar-IQ',font:'Noto Sans Arabic',rtl:true,align:'right',accentColor:'#A23E16'},
 {id:'STYLE-CKB',text:'سڵاو NOVA جیهان\nنرخی تایبەت: ٢٥٬٠٠٠ دینار',language:'ckb',locale:'ckb',font:'Cairo',rtl:true,align:'center',accentColor:'#A23E16'},
 {id:'STYLE-EN',text:'MEET NOVA AT\nWorkshop 2026',language:'en',locale:'en-GB',font:'Verdana',rtl:false,align:'left',accentColor:'#A23E16',accentText:'NOVA'},
 {id:'STYLE-MIXED',text:'NOVA ONE — بۆ هەنگاوی داهاتوو\nکاتژمێر 8:30 PM',language:'mixed',locale:'und',font:'Noto Sans Arabic',rtl:false,align:'left'},
];
const layout:StudioLayoutV2={version:2,width:1080,height:1200,background:{color:'#F6F8FC'},grid:{margin:60,columns:12,gutter:24,baseline:8},shapes:[],logo:{x:0,y:0,width:10,height:10},
 text:styled.map((c,i)=>({copyIndex:i,role:'body',x:60+(i%2)*500,y:80+Math.floor(i/2)*540,width:460,height:410,fontSize:32,lineHeight:1.7,fontFamily:c.font,color:'#14253D',align:c.align as 'left'|'right'|'center',rtl:c.rtl,accentColor:c.accentColor,accentText:c.accentText}))};
const second=await encodeStudioTransferV2(layout,styled.map(c=>c.text),undefined,{copyLocales:styled.map(c=>c.locale)});
writeFileSync(out+'locale-v2-input.pptx',second.bytes);
groups.push({id:'locale-v2',file:'locale-v2-input.pptx',bytes:second.bytes.length,sha256:second.sha256,cases:styled,manifest:second.manifest,layout,
 scope:'Four synthetic blocks, 460px boxes, three declared families, RTL paragraph accents and Latin inline color runs. Explicit false RTL retained as a negative direction control; not human language approval.'});
const manifest={schemaVersion:1,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 corpus:{path:'evals/rtl_golden_cases.jsonl',sha256:digest(readFileSync(root+'evals/rtl_golden_cases.jsonl')),caseCount:14},
 sourceHashes:Object.fromEntries(['packages/creative/src/editable-transfer.ts','packages/creative/src/studio/transfer-v2.ts','packages/qa/src/canva-pptx-check.ts','packages/integrations/src/canva-connect-client.ts','apps/core/src/services/canva-connect-service.ts'].map(p=>[p,digest(readFileSync(root+p))])),groups,
 fullMultilingualAdmission:false};
writeFileSync(out+'fixtures.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:manifest.sourceCommit,designCount:groups.length,caseCount:14,providerCalls:0}));
