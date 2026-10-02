/** Independent PPTX->PDF pixel check; masks typography/logo and source boundaries, not fields. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { PNG } = createRequire(new URL('../../packages/creative/package.json', import.meta.url))('pngjs');
const base = resolve(process.argv[2] || '/tmp/hawa-topology-controls');
const proof = JSON.parse(readFileSync(join(base,'CONTROLS.json'),'utf8'));
for (const c of proof.controls) {
 const layout = JSON.parse(readFileSync(join(base,c.recipe+'.layout.json'),'utf8'));
 const preview = PNG.sync.read(readFileSync(join(base,c.recipe+'.png')));
 const native = PNG.sync.read(readFileSync(join(base,c.recipe+'-native.png')));
 const pdf = readFileSync(join(base,c.recipe+'.pdf'));
 const page = /\/MediaBox\[0 0 ([0-9.]+) ([0-9.]+)\]/.exec(pdf.toString('latin1'));
 if (!page) throw new Error('Missing native page geometry');
 const pixels = {width:Number(page[1])*96/72,height:Number(page[2])*96/72};
 if (Math.abs(pixels.width-layout.width)>.1 || Math.abs(pixels.height-layout.height)>.1 || native.width<layout.width || native.width>layout.width+1 || native.height<layout.height || native.height>layout.height+1) throw new Error('Native geometry differs beyond page-point rounding');
 const mask = [...layout.text,layout.logo].filter(Boolean);
 const excluded = (x,y) => mask.some(b=>x>=b.x-32 && x<b.x+b.width+32 && y>=b.y-32 && y<b.y+b.height+32);
 const delta = (a,b) => Math.max(Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1]),Math.abs(a[2]-b[2]));
 const at = (p,x,y) => {const k=(y*p.width+x)*4;return [p.data[k],p.data[k+1],p.data[k+2]];};
 let compared=0,mismatch=0,maxDifference=0,sourcePixels=0; const mismatchSamples=[];
 for (let y=4;y<layout.height-4;y++) for(let x=4;x<layout.width-4;x++) {
  if(excluded(x,y))continue;
  if((layout.photos??[]).some(p=>x>=p.x-3 && x<p.x+p.width+3 && y>=p.y-3 && y<p.y+p.height+3 && !(x>=p.x+3 && x<p.x+p.width-3 && y>=p.y+3 && y<p.y+p.height-3)))continue;
  const a=at(preview,x,y);
  // Exclude <=3px neighborhoods of source/shape boundaries to avoid two resamplers' aliasing.
  if([[x-3,y],[x+3,y],[x,y-3],[x,y+3],[x-3,y-3],[x+3,y-3],[x-3,y+3],[x+3,y+3]].some(([xx,yy])=>delta(a,at(preview,xx,yy))>3)) continue;
  const d=delta(a,at(native,x,y));compared++;maxDifference=Math.max(maxDifference,d);if(d>3) { mismatch++; if(mismatchSamples.length<8)mismatchSamples.push({x,y,preview:a,native:at(native,x,y),delta:d}); }
  if((layout.photos??[]).some(p=>x>=p.x && x<p.x+p.width && y>=p.y && y<p.y+p.height))sourcePixels++;
 }
 c.nativeGeometry={renderer:'LibreOfficeDev 26.8 alpha -> pdftoppm 96 dpi',comparedPixels:compared,comparedSourcePixels:sourcePixels,mismatchPixels:mismatch,maxDifference,mismatchSamples,
  mask:'Text/logo expanded32px and local3px source/shape color boundary neighborhoods in eight directions and photo rectangle edges; extra native page fringe excluded',pagePixels:pixels,
  nativeFontNames:[...new Set([...pdf.toString('latin1').matchAll(/\/(?:FontName|BaseFont)\s*\/([^\s/<>]+)/g)].map(m=>m[1]))],
  pdfSha256:createHash('sha256').update(pdf).digest('hex'),passed:mismatch===0};
 if(mismatch) {writeFileSync(join(base,'CONTROLS.json'),JSON.stringify(proof,null,2)+'\n');throw new Error(`${c.recipe}: ${mismatch}/${compared} pixels differ; max ${maxDifference}`);}
}
proof.nativeTypographyQualification='NOT_PASSED: source Verdana fidelity requires separate font-name/ink checks; font cache warnings retained; masked geometry check is not typography proof';
proof.canvaQualification='not_run';writeFileSync(join(base,'CONTROLS.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify({controls:proof.controls.length,comparedPixels:proof.controls.reduce((s,c)=>s+c.nativeGeometry.comparedPixels,0),comparedSourcePixels:proof.controls.reduce((s,c)=>s+c.nativeGeometry.comparedSourcePixels,0),passed:true,canvaQualification:'not_run'}));
