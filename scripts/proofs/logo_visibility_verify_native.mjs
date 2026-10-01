/** Read the official-source feature signature on an independent PPTX->PDF->PNG export. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRenderedLogoVisibility } from '../../packages/creative/dist/studio/art-direction/logo-ground.js';
const base=resolve(process.argv[2]||'/tmp/hawa-logo-visibility-controls');
const proof=JSON.parse(readFileSync(join(base,'CONTROLS.json'),'utf8'));
let failed=0,missingFontControls=0;
for(const c of proof.controls){
  const layout=JSON.parse(readFileSync(join(base,c.name+'.layout.json'),'utf8'));
  const template=JSON.parse(readFileSync(join(base,c.name+'.template.json'),'utf8'));
  const png=readFileSync(join(base,c.name+'-native.png')),pdf=readFileSync(join(base,c.name+'.pdf'));
  const reading=readRenderedLogoVisibility(png,layout.logo,template);
  const fontNames=[...new Set([...pdf.toString('latin1').matchAll(/\/(?:FontName|BaseFont)\s*\/([^\s/<>]+)/g)].map(m=>m[1]))];
  const normalize=s=>s.replace(/^[A-Z]{6}\+/,'').replace(/[^a-z0-9]/gi,'').toLowerCase();
  const requestedFamilies=[...new Set(layout.text.map(t=>t.fontFamily))];
  const missingFamilies=requestedFamilies.filter(f=>!fontNames.some(n=>{
    const name=normalize(n),family=normalize(f);
    return name.startsWith(family)&&/^(?:regular|bold|italic|oblique|semibold|extrabold|medium|black)*$/.test(name.slice(family.length));
  }));
  if(missingFamilies.length)missingFontControls++;
  c.native={reading,pngSha256:createHash('sha256').update(png).digest('hex'),pdfSha256:createHash('sha256').update(pdf).digest('hex'),fontNames,
    requestedFamilies,missingFamilies,fontFamilyPresencePassed:missingFamilies.length===0,
    renderer:(proof.nativeExport?.renderer||'LibreOfficeDev 26.8 alpha')+' -> pdftoppm96dpi; no logo mask or coordinate search',passed:reading.passed};
  if(!reading.passed)failed++;
}
proof.nativeTypographyQualification=missingFontControls?'FAILED_DECLARED_FONT_FAMILY_PRESENCE':'FONT_FAMILY_PRESENCE_PASS_ONLY: actual glyph/ink/bidi/Canva fidelity NOT_RUN';
proof.nativeDeclaredFontFamiliesPassed=missingFontControls===0;
proof.nativeVisibilityPassed=failed===0;
writeFileSync(join(base,'CONTROLS.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify({controls:proof.controls.length,failed,missingFontControls,passed:failed===0&&missingFontControls===0,canvaQualification:'NOT_RUN'}));
if(failed||missingFontControls)process.exitCode=1;
