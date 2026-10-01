import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(root+'/packages/creative/package.json');
const {PNG}=require('pngjs');
const studio=await import(pathToFileURL(root+'/packages/creative/dist/studio/render-layout-v2.js'));
const ground=await import(pathToFileURL(root+'/packages/creative/dist/studio/art-direction/logo-ground.js'));
const {rendererRuntimeIdentity}=await import(pathToFileURL(root+'/packages/creative/dist/studio/renderer-identity.js'));
const {getKaaeOfficialLogoDataUri}=await import(pathToFileURL(root+'/packages/creative/dist/operations-to-svg.js'));
const logoDataUri=getKaaeOfficialLogoDataUri();
const options={logoDataUri};
const layout={version:2,width:1080,height:1350,grid:{margin:80,columns:12,gutter:16,baseline:8},background:{color:'#FFFFFF'},text:[],shapes:[],logo:{x:88,y:88,width:164,height:164}};
async function original(l){
 const {noTextSvg,files}=studio.renderLayoutV2ToSvg(l,options);
 const logo=noTextSvg.match(/<image id="logo"[^>]*\/>/)?.[0];if(!logo)throw Error('Missing exact source');
 const {x,y,width,height}=l.logo;
 const open=`<svg width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`;
 const white=`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#FFFFFF"/>`;
 const [a,b]=await Promise.all([studio.svgToPngAsync(`${open}${white}${logo}</svg>`,width,height,options,files),studio.svgToPngAsync(`${open}${white}</svg>`,width,height,options,files)]);
 const matte=PNG.sync.read(b);if(!matte.data.every(v=>v===255))throw Error('Native matte differs');
 return ground.readLogoGround(PNG.sync.read(a),matte,l.logo,l.logo).contrast;
}
if(!process.argv[2])throw Error('Usage: node scripts/proofs/logo_reference_matte_benchmark.mjs fresh-output.json');
const output=path.resolve(process.argv[2]);if(fs.existsSync(output))throw Error('Evidence already exists');
const sourceBefore=createHash('sha256').update(Buffer.from(logoDataUri.split(',')[1],'base64')).digest('hex');
await original(layout);await ground.nativeLogoContrast(layout,options);
const cases=[{x:88,y:88,width:164,height:164},{x:72.25,y:79.5,width:120,height:120},{x:85,y:72.75,width:110,height:110}],records=[];
const run=async(fn,l)=>{const start=performance.now(),contrast=await fn(l,options);return{ms:performance.now()-start,contrast};};
for(const [caseIndex,box] of cases.entries())for(let trial=0;trial<3;trial++){
 const l={...layout,logo:box};let a,b;
 if(trial%2===0){a=await run(original,l);b=await run(ground.nativeLogoContrast,l);}else{b=await run(ground.nativeLogoContrast,l);a=await run(original,l);}
 if(a.contrast!==b.contrast)throw Error('Native contrast drift');records.push({caseIndex,trial,legacy:a,optimized:b});
}
const median=xs=>{const sorted=[...xs].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
const a=median(records.map(r=>r.legacy.ms)),b=median(records.map(r=>r.optimized.ms));
const result={date:new Date().toISOString(),scope:'Nine warm paired local helper measurements; explicit packaged official test logo, synthetic empty-copy controls. Not pipeline p95, Canva or human quality.',runtime:rendererRuntimeIdentity(options),sourceAssetSha256:sourceBefore,sourceUnchanged:sourceBefore===createHash('sha256').update(Buffer.from(logoDataUri.split(',')[1],'base64')).digest('hex'),contrastEqualityPassed:records.length,nativeJobsPerMeasurement:{legacy:2,optimized:1,actualDelegatingSpyEvidence:'/tmp/hawa-w5-matte-connected-20261001.log'},medianMs:{legacy:a,optimized:b},relativeMedianChange:(b-a)/a,records,newProviderCalls:0,codeSha256:createHash('sha256').update(fs.readFileSync(root+'/packages/creative/src/studio/art-direction/logo-ground.ts')).digest('hex')};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,contrastEqualityPassed:records.length,medianMs:result.medianMs,relativeMedianChange:result.relativeMedianChange,nativeJobsPerMeasurement:result.nativeJobsPerMeasurement,sourceUnchanged:result.sourceUnchanged}));
