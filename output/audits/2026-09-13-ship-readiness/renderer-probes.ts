// Read-only renderer audit. No external requests, no client files modified.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {renderOperationsToSvg,renderOperationsToPng,getKaaeOfficialLogoDataUri} from '../../../packages/creative/src/operations-to-svg.js';
const svg=renderOperationsToSvg([{op:'addImage',pageId:'p1',nodeId:'another_client_logo',asset:{storageKey:'client-b/approved-logo.png',sha256:'another-client-approved-hash'},x:0,y:0,width:100,height:100}] as any,200,200);
const logo=getKaaeOfficialLogoDataUri();
const previousPath=process.env.PATH;
process.env.PATH='/audit/nonexistent-binaries';
let rasterFailure:any;
try{const b=renderOperationsToPng([],200,200);rasterFailure={returnedBytes:b.length};}catch(e:any){rasterFailure={rejected:true,error:e.message};}finally{process.env.PATH=previousPath;}
const result={timestamp:new Date().toISOString(),otherClientLogoReplacedWithKaae:!!logo&&svg.includes(logo),svgSha256:crypto.createHash('sha256').update(svg).digest('hex'),rasterFailure};
fs.writeFileSync(new URL('./RENDERER_PROBES.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
