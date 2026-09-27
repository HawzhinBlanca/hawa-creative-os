import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root=new URL('../../../',import.meta.url),out=new URL('.',import.meta.url);
const read=(path:string)=>JSON.parse(readFileSync(new URL(path,root),'utf8'));
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const candidate=read('output/acceptance/2026-09-27-explicit-direction/candidate-rehearsal.json');
if(candidate.deployment.commit!==source||Object.keys(candidate.deployment.sourceChanges).length)throw new Error('Candidate source mismatch');
const image=execFileSync('docker',['inspect','--format','{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}','hawa-chaos-core-1'],{encoding:'utf8'}).trim().split('|');
if(image[1]!==source)throw new Error('Running Core image mismatch');
const fixture=read('output/acceptance/2026-09-27-explicit-direction/fixtures.json').groups[0];
const older=read('output/acceptance/2026-09-27-canva-locale/fixtures.json').groups[1];
const sources=[{name:'corrected',group:fixture,path:'output/acceptance/2026-09-27-explicit-direction/direction-v2-canva.pptx'},
 {name:'retained_direction_conflict',group:older,path:'output/acceptance/2026-09-27-canva-locale/locale-v2-canva.pptx'}];
const payload={layout:fixture.layout,locales:fixture.cases.map((c:any)=>c.locale),cases:sources.map(s=>({name:s.name,
 copy:s.group.cases.map((c:any)=>c.text),directions:s.group.cases.map((c:any)=>c.rtl?'rtl':'ltr'),
 bytes:readFileSync(new URL(s.path,root)).toString('base64')}))};
const code=`
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkCanvaPptx } from '/app/packages/qa/dist/canva-pptx-check.js';
import { evaluateCanvaExportQc } from '/app/apps/core/dist/core-helpers.js';
import { encodeStudioTransferV2 } from '/app/packages/creative/dist/studio/transfer-v2.js';
const payload=JSON.parse(readFileSync(0,'utf8'));
const options={allowedFontsByScript:{latin:['Noto Sans Arabic','Cairo','Verdana'],arabic:['Noto Sans Arabic','Cairo']}};
const results=[];
for(const c of payload.cases){
 const bytes=Buffer.from(c.bytes,'base64'),sha256=createHash('sha256').update(bytes).digest('hex');
 const check=checkCanvaPptx(bytes,c.copy,{...options,directionsByIndex:c.directions});
 const row={format:'pptx',sha256,content:bytes,content_check:{...check,expectedCopy:c.copy}};
 const result=evaluateCanvaExportQc(row,c.copy.map(text=>({text})));
 const wrong=evaluateCanvaExportQc(row,c.copy.map((text,i)=>({text:i===0?'UNAPPROVED':text})));
 if(wrong.qaReport.criticalPass!==false)throw new Error('Changed task copy accepted');
 if(c.name==='corrected'&&(result.qaReport.criticalPass!==true||result.qaReport.rtlVisualReviewRequired!==true||result.qaReport.bidiIsolation!==null||result.qaReport.fontCoverage!==null))throw new Error('Corrected native check lost review boundary');
 if(c.name!=='corrected'&&result.qaReport.criticalPass!==false)throw new Error('Retained direction conflict accepted');
 results.push({name:c.name,sha256,criticalPass:result.qaReport.criticalPass,visualReviewRequired:result.qaReport.rtlVisualReviewRequired,bidiIsolation:result.qaReport.bidiIsolation,fontCoverage:result.qaReport.fontCoverage,copyMutationRejected:true,directionViolations:check.directionViolations.length,paragraphs:check.paragraphDirections});
}
const transfer=await encodeStudioTransferV2(payload.layout,payload.cases[0].copy,undefined,{copyLocales:payload.locales});
const transferCheck=checkCanvaPptx(transfer.bytes,payload.cases[0].copy,{...options,directionsByIndex:payload.cases[0].directions});
if(transfer.plan.text.map(t=>t.rtl?'rtl':'ltr').join()!==payload.cases[0].directions.join()||transferCheck.rtlPass!==true||transferCheck.copyPass!==true)throw new Error('Deployed encoder direction mismatch');
console.log(JSON.stringify({results,compiledEncoder:{directions:transfer.plan.text.map(t=>t.rtl?'rtl':'ltr'),copyPass:transferCheck.copyPass,rtlPass:transferCheck.rtlPass,metadataPass:transferCheck.rtlMetadataPass},providerCalls:0}));
`;
let measured:any;
try{measured=JSON.parse(execFileSync('docker',['exec','-i','hawa-chaos-core-1','node','--input-type=module','-e',code],{input:JSON.stringify(payload),encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:4*1024*1024}));}
catch(error){
 const stderr=String((error as {stderr?:unknown}).stderr||'');
 const diagnostic=stderr.split('\n').find(line=>/^(Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module|TypeError: Cannot read properties|Error: (Changed task copy accepted|Corrected native check lost review boundary|Retained direction conflict accepted|Deployed encoder direction mismatch))/.test(line));
 if(diagnostic)console.error(diagnostic.slice(0,300));
 throw new Error('Compiled candidate native checks failed; no runtime configuration was logged');
}
const result={checkedAt:new Date().toISOString(),sourceCommit:source,imageId:image[0],...measured,
 artifactHashes:Object.fromEntries(sources.map(s=>[s.path,createHash('sha256').update(readFileSync(new URL(s.path,root))).digest('hex')])),
 scope:'Actual retained Canva bytes evaluated by compiled candidate Core and QA; compiled Studio generates same fixture. No HTTP task mutation or human approval.',productionChanged:false};
writeFileSync(new URL('candidate-native-direction.json',out),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:source,nativeCases:result.results.length,compiledEncoder:result.compiledEncoder,providerCalls:0,productionChanged:false}));
