/** W3 synthetic controls. No providers/customer material; independent native pass is separate. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { solveRecipe } from '../../packages/creative/dist/studio/art-direction/solver.js';
import { renderLogoTemplate, settleLogoGround, readRenderedLogoVisibility } from '../../packages/creative/dist/studio/art-direction/logo-ground.js';
import { renderLayoutV2Async } from '../../packages/creative/dist/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../../packages/creative/dist/studio/transfer-v2.js';
import { evaluateHardQa } from '../../packages/creative/dist/studio/hard-qa.js';
const require = createRequire(new URL('../../packages/creative/package.json', import.meta.url));
const { PNG } = require('pngjs'), { unzipSync } = require('fflate');
const out = resolve(process.argv[2] || '/tmp/hawa-logo-visibility-controls'); mkdirSync(out, { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const logoBytes = readFileSync(new URL('../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url));
const palette = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const controls = [];
for (const [name, rgb, busy, width, height, rtl] of [
  ['pale-portrait',[214,218,222],false,1080,1350,false], ['dark-portrait',[15,25,40],false,1080,1350,false],
  ['busy-portrait',[100,120,140],true,1080,1350,false], ['pale-wide-rtl',[232,236,240],false,1920,1080,true],
  ['dark-wide-rtl',[15,25,40],false,1920,1080,true], ['busy-wide',[100,120,140],true,1920,1080,false],
]) {
  const photo = new PNG({ width: 1800, height: 1500 });
  for (let y=0; y<photo.height; y++) for(let x=0;x<photo.width;x++) {
    const k=(y*photo.width+x)*4, check=((x>>3)+(y>>3))%2;
    for(let c=0;c<3;c++)photo.data[k+c]=busy?(check?235:30):rgb[c]; photo.data[k+3]=255;
  }
  const bytes=PNG.sync.write(photo), photos=[{ photoIndex:0,width:photo.width,height:photo.height,bytes,mimeType:'image/png',regionStatus:'measured',regions:[] }];
  const copy={0:'Source artwork stays intact',1:'Measured local placement',2:'Original logo and source photo bytes'}, options={copyText:copy,photoFiles:photos,logoDataUri:`data:image/png;base64,${logoBytes.toString('base64')}`};
  const raw=solveRecipe({width,height,photos,palette,logoAspect:1,copy:{text:copy},
    choice:{recipe:'hero_fade_report',heroPhotoIndex:0,texturePhotoIndex:null,cutoutPhotoIndex:null,
      slots:[{copyIndex:0,slot:'title'},{copyIndex:1,slot:'accent'},{copyIndex:2,slot:'body'}],params:{rtl}}});
  const start=performance.now(), layout=await settleLogoGround(raw,{render:options,palette});
  const settlementMs=performance.now()-start, template=await renderLogoTemplate(layout,options), rendered=await renderLayoutV2Async(layout,options);
  const reading=readRenderedLogoVisibility(rendered.noTextPng,layout.logo,template);
  const qa=evaluateHardQa(layout,{width,height,palette,copyText:copy,copyScripts:['latin','latin','latin'],latinFont:'Verdana',arabicFont:'Noto Sans Arabic',
    logoAspect:1,photoCount:1,photoRegions:photos,renderedComposite:rendered.noTextPng,logoVisibilityRequired:true,logoVisibilityTemplate:template});
  if(!qa.passed)throw new Error(`${name}: ${qa.messages.join('; ')}`);
  const transfer=await encodeStudioTransferV2(layout,Object.values(copy),{bytes:logoBytes,sha256:hash(logoBytes),mimeType:'image/png'},{photos});
  const zip=unzipSync(transfer.bytes),media=Object.entries(zip).filter(([p])=>p.startsWith('ppt/media/')&&!p.endsWith('/')).map(([,b])=>hash(b));
  if(!media.includes(hash(logoBytes))||!media.includes(hash(bytes)))throw new Error('Original source bytes changed');
  writeFileSync(join(out,name+'.png'),rendered.png);writeFileSync(join(out,name+'.pptx'),transfer.bytes);
  writeFileSync(join(out,name+'.layout.json'),JSON.stringify(layout));writeFileSync(join(out,name+'.template.json'),JSON.stringify(template));
  controls.push({name,width,height,rtl,logoHash:hash(logoBytes),sourceHash:hash(bytes),treatment:layout.artDirection.logoGround,reading,settlementMs,
    previewSha256:hash(rendered.png),pptxSha256:hash(transfer.bytes),sourceIdentityPassed:true,hardQaPassed:true});
}
writeFileSync(join(out,'CONTROLS.json'),JSON.stringify({controls,providerCalls:0,canvaQualification:'NOT_RUN',humanCalibration:'NOT_RUN'},null,2)+'\n');
console.log(JSON.stringify({out,controls:controls.length,passed:true,providerCalls:0}));
