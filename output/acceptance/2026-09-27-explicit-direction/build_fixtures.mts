import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeStudioTransferV2 } from '../../../packages/creative/src/studio/transfer-v2.ts';
import { checkCanvaPptx } from '../../../packages/qa/src/canva-pptx-check.ts';
import type { StudioLayoutV2 } from '../../../packages/creative/src/studio/layout-v2.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=fileURLToPath(new URL('.',import.meta.url));
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
if(existsSync(out+'fixtures.json'))throw new Error('Reuse frozen fixtures; do not regenerate');
const originalPath='output/acceptance/2026-09-27-canva-locale/fixtures.json';
const original=JSON.parse(readFileSync(root+originalPath,'utf8')).groups[1];
const cases=[...original.cases,
 {id:'LTR-ACCENT',text:'NOVA — سڵاو جیهان\nکاتژمێر 8:30 PM',language:'mixed',locale:'und',font:'Cairo',rtl:false,align:'left',accentColor:'#A23E16'},
 {id:'LTR-ARABIC-FIRST',text:'سڵاو جیهان\nNOVA at 8:30 PM',language:'mixed',locale:'und',font:'Noto Sans Arabic',rtl:false,align:'left'},
];
const layout:StudioLayoutV2={...original.layout,height:1740,text:cases.map((c,i)=>({
 copyIndex:i,role:'body',x:60+(i%2)*500,y:80+Math.floor(i/2)*540,width:460,height:410,
 fontSize:32,lineHeight:1.7,fontFamily:c.font,color:'#14253D',align:c.align,rtl:c.rtl,
 accentColor:c.accentColor,accentText:c.accentText,
}))};
const encoded=await encodeStudioTransferV2(layout,cases.map(c=>c.text),undefined,{copyLocales:cases.map(c=>c.locale)});
writeFileSync(out+'direction-v2-input.pptx',encoded.bytes);
const local=checkCanvaPptx(encoded.bytes,cases.map(c=>c.text),{fontsByIndex:cases.map(c=>c.font),directionsByIndex:cases.map(c=>c.rtl?'rtl':'ltr')});
writeFileSync(out+'local-qa.json',JSON.stringify(local,null,2)+'\n');
const manifest={schemaVersion:1,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 sourceTreeClean:!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),
 corpus:{path:originalPath,sha256:digest(readFileSync(root+originalPath)),caseCount:cases.length},
 sourceHashes:Object.fromEntries(['packages/creative/src/editable-transfer.ts','packages/creative/src/studio/transfer-v2.ts','packages/qa/src/canva-pptx-check.ts','packages/integrations/src/canva-connect-client.ts','apps/core/src/services/canva-connect-service.ts'].map(p=>[p,digest(readFileSync(root+p))])),
 groups:[{id:'direction-v2',file:'direction-v2-input.pptx',bytes:encoded.bytes.length,sha256:encoded.sha256,cases,manifest:encoded.manifest,layout,
  baseline:'output/acceptance/2026-09-27-canva-locale/locale-v2-canva.png',
  baselineSha256:digest(readFileSync(root+'output/acceptance/2026-09-27-canva-locale/locale-v2-canva.png')),
  scope:'Same first four blocks as retained negative control, plus LTR Arabic-font accent and Arabic-first cases; height extended for last row. Direction comes from the explicit layout flags. No human language approval.'}],
 fullMultilingualAdmission:false};
writeFileSync(out+'fixtures.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({baseCommit:manifest.sourceCommit,sourceTreeClean:manifest.sourceTreeClean,designCount:1,caseCount:cases.length,localCopyPass:local.copyPass,localDirectionPass:local.rtlPass,localDirectionMetadata:local.rtlMetadataPass,providerCalls:0}));
