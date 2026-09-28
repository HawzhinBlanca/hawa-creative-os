import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCanvaPptx } from '../../../packages/qa/src/canva-pptx-check.ts';
const out=fileURLToPath(new URL('.',import.meta.url));
const bytes=readFileSync(out+'baseline.pptx');
const copy=['HAWA EDITABLE IMPORT TEST','Exact copy: Mr. / Ms. / Dr. [EDITABLE TEST]','13 September 2026 | 2:30 PM'];
// Arial is the observed and explicit family of this synthetic historical fixture.
// This does not alter any production client policy or admit Arial globally.
const allowed={allowedFontsByScript:{latin:['Arial'],arabic:[]}};
const actual=checkCanvaPptx(bytes,copy,allowed);
if(!actual.copyPass||!actual.fontPass||actual.sourceTextObjects?.length!==3||actual.fullReleasePass)throw new Error('Actual export failed bounded copy/font/addressability contract');
const wrongCopy=checkCanvaPptx(bytes,[copy[0],copy[1].replace('[EDITABLE TEST]','[REOPEN CHECK]'),copy[2]],allowed);
if(wrongCopy.copyPass)throw new Error('Uncommitted replacement was incorrectly accepted');
const wrongFont=checkCanvaPptx(bytes,copy,{allowedFontsByScript:{latin:['Verdana'],arabic:[]}});
if(wrongFont.fontPass)throw new Error('Incorrect client family was accepted');
const receipt={schemaVersion:1,actual,negativeControls:{uncommittedCopyRefused:!wrongCopy.copyPass,wrongFamilyRefused:!wrongFont.fontPass},scope:'Current source QA applied to an actual Canva export; no native editability or complete release verdict inferred.'};
writeFileSync(out+'current-qa-check.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({copyPass:actual.copyPass,fontPass:actual.fontPass,addressableTextObjects:actual.sourceTextObjects.length,fullReleasePass:actual.fullReleasePass,negativeControls:receipt.negativeControls}));
