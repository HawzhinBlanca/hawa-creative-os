import {createHash} from 'node:crypto';
import {parseAndValidatePng} from '@hawa/integrations';
import {checkCanvaPptx,readPptxTextLayout,type PptxCheckOptions} from '@hawa/qa';
import {checkExportPictures} from '../services/export-picture-fidelity.js';
import {savedDesignCopy} from '../services/saved-design-copy.js';
import {customerValueHash} from './customer-web-lifecycle.js';

export interface NativeReviewObservation {
 tenantId:string;actorId:string;designId:string;capturedVersion:string;
}
export interface CustomerNativeVersionReader {
 observeCustomerDesign(input:NativeReviewObservation):Promise<{ok:boolean;code?:'CANVA_DESIGN_CHANGED'|'CANVA_DESIGN_CHECK_UNAVAILABLE';observedVersion?:string}>;
}
interface FileEvidence {id:string;sha256:string;size:number}
export interface CustomerNativeBasis {
 taskId:string;requestVersion:number;revisionId:string;bindingId:string;bindingVersion:number;
 designId:string;actorId:string;nativeVersion:string;preview:FileEvidence;
 export:FileEvidence&{contentCheck:Record<string,unknown>|null};
 source:FileEvidence&{manifest:Record<string,unknown>};
 qc:{id:string;status:string;criticalPass:boolean|null;report:Record<string,unknown>};
 policy:{version:number;kind:string;sourceId?:string;copy:string[];requiredFont?:string;options:PptxCheckOptions}|null;
 activeDna:{version:number;sha256:string};dimensions:{width:number;height:number};policyCurrent:boolean;creation:unknown;
}
export interface CustomerNativeBundle {basis:CustomerNativeBasis;png:Buffer|null;pptx:Buffer|null;source:Buffer|null}
export type CustomerReviewReason='FILES_INVALID'|'DIMENSIONS_CHANGED'|'COPY_CHANGED'|'CAPTURE_POLICY_CHANGED'|'QUALITY_CHECK_FAILED'|
 'RTL_REVIEW_REQUIRED'|'ASSET_FIDELITY_FAILED'|'NATIVE_DESIGN_CHANGED'|'NATIVE_CHECK_UNAVAILABLE';
export interface CustomerNativeReview {
 status:'ready'|'blocked';requestVersion:number;previewId:string;previewSha256:string;
 basisSha256:string;checkedAt:string;reasons:CustomerReviewReason[];
 files:Array<FileEvidence&{format:'png'|'pptx'}>;
}
export const nativeReviewFingerprint=(basis:CustomerNativeBasis)=>customerValueHash(basis);
const validBytes=(bytes:Buffer|null,file:FileEvidence)=>Boolean(bytes && bytes.length>=32 && bytes.length<=26214400 &&
 bytes.length===file.size && createHash('sha256').update(bytes).digest('hex')===file.sha256);

/** Re-read actual captured bytes; stored positive flags alone never qualify a customer file. */
export async function inspectCustomerNativeFiles(bundle:CustomerNativeBundle):Promise<CustomerReviewReason[]> {
 const {basis:b,png,pptx,source}=bundle, reasons=new Set<CustomerReviewReason>();
 if(!validBytes(png,b.preview)||!validBytes(pptx,b.export)||!validBytes(source,b.source)||!parseAndValidatePng(png!).ok)
  return ['FILES_INVALID'];
 const image=parseAndValidatePng(png!);
 try {
  const nativeLayout=readPptxTextLayout(pptx!),sourceLayout=readPptxTextLayout(source!);
  const {width,height}=b.dimensions;
  if(!image.ok || image.width!==width || image.height!==height ||
    [nativeLayout,sourceLayout].some(l=>Math.abs(l.slideWidth/9525-width)>1 || Math.abs(l.slideHeight/9525-height)>1))
   reasons.add('DIMENSIONS_CHANGED');
 } catch {reasons.add('FILES_INVALID');}
 const policy=b.policy;
 if(!policy || policy.version!==1 || !b.policyCurrent || !['imported_source','manual_client_dna','initial_client_dna','revision_client_dna'].includes(policy.kind) ||
  (policy.kind==='imported_source' && policy.sourceId!==b.source.id) ||
  !policy.options || typeof policy.options!=='object' ||
  (!policy.requiredFont && !policy.options.fontsByIndex?.length && !policy.options.allowedFontsByScript))
  return ['CAPTURE_POLICY_CHANGED'];
 const envelope=b.creation && typeof b.creation==='object' ? b.creation as {payload?:{clientDnaVersion?:number};clientDnaVersion?:number}:{};
 if((envelope.payload || envelope).clientDnaVersion!==Number(b.activeDna.version))return ['CAPTURE_POLICY_CHANGED'];
 let copy:string[];
 try {copy=savedDesignCopy(b.creation,'').copy;} catch {return ['COPY_CHANGED'];}
 if(!copy.length || copy.length>8 || copy.some(text=>!text.trim()) || copy.join('').length>8000 ||
  customerValueHash(copy)!==customerValueHash(policy.copy) || customerValueHash(copy)!==customerValueHash(b.source.manifest.copy))
  return ['COPY_CHANGED'];
 if(b.qc.status!=='passed' || b.qc.criticalPass!==true || b.qc.report.exportArtifactId!==b.export.id ||
  b.qc.report.captureVersion!==b.nativeVersion || b.qc.report.exportSha256!==b.export.sha256 ||
  b.export.contentCheck?.status==='failed' || b.export.contentCheck?.copyPass===false || b.export.contentCheck?.fontPass===false || b.export.contentCheck?.rtlPass===false)
  reasons.add('QUALITY_CHECK_FAILED');
 try {
  const sourceCheck=checkCanvaPptx(source!,copy,policy.requiredFont || policy.options,policy.options);
  if(!sourceCheck.copyPass || !sourceCheck.fontPass || !sourceCheck.rtlPass)reasons.add('QUALITY_CHECK_FAILED');
  const parsed=checkCanvaPptx(pptx!,copy,policy.requiredFont || policy.options,policy.options);
  if(!parsed.copyPass || !parsed.fontPass || !parsed.rtlPass)reasons.add('QUALITY_CHECK_FAILED');
  // Paragraph flags do not establish native glyph joining or bidi rendering.
  if(parsed.rtlVisualReviewRequired || b.qc.report.rtlVisualReviewRequired===true)reasons.add('RTL_REVIEW_REQUIRED');
 } catch {reasons.add('QUALITY_CHECK_FAILED');}
 try {
  const raw=b.source.manifest.logo;
  const box=raw && typeof raw==='object' ? raw as {x:number;y:number;width:number;height:number} : undefined;
  if(raw && (!box || ![box.x,box.y,box.width,box.height].every(Number.isFinite) || box.width<=0 || box.height<=0))
   reasons.add('ASSET_FIDELITY_FAILED');
  else {
   const pictures=await checkExportPictures(source!,pptx!,box ? {logoBoxPx:box} : {});
   if(!pictures.pass || (box && pictures.logo!=='preserved'))reasons.add('ASSET_FIDELITY_FAILED');
  }
 } catch {reasons.add('ASSET_FIDELITY_FAILED');}
 return [...reasons];
}
export function customerNativeReviewResult(basis:CustomerNativeBasis,reasons:CustomerReviewReason[]):CustomerNativeReview {
 return {status:reasons.length ? 'blocked':'ready',requestVersion:Number(basis.requestVersion),previewId:basis.preview.id,
 previewSha256:basis.preview.sha256,basisSha256:nativeReviewFingerprint(basis),checkedAt:new Date().toISOString(),reasons,
 files:reasons.length ? []:[{...basis.preview,format:'png'},{id:basis.export.id,sha256:basis.export.sha256,size:basis.export.size,format:'pptx'}]};
}
