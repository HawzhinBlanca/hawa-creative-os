/** A deterministic input validation failure; storage/encoding exceptions remain retryable. */
export class EditableTransferValidationError extends Error {
  readonly code='EDITABLE_TRANSFER_INVALID';
  constructor(message:string){super(message);this.name='EditableTransferValidationError';}
}
import { createRequire } from 'node:module';
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs');
import { createHash } from 'node:crypto';
import { effectiveLetterSpacingEm } from './studio/render-layout-v2.js';
import { isFontAdmitted } from './font-policy.js';

export interface EditableTransferPlan {
  width: number; height: number; background: string;
  text: Array<{ copyIndex: number; x: number; y: number; width: number; height: number;
    fontSize: number; fontFamily: string; color: string; align: 'left'|'center'|'right'; bold?: boolean;
    italic?: boolean;
    opacity?: number;
    /** Tracking in em, as the layout and the raster renderer express it, not in points. */
    letterSpacing?: number;
    /** Line height multiple from the layout. Falls back to 1.4 when a caller does not supply it. */
    lineHeight?: number;
    /** Right-to-left block. Direction does not identify the copy's language. */
    rtl?: boolean }>;
  /**
   * Shape geometry mirrors the raster renderer. Without `kind`, `opacity` and the stroke fields
   * every shape was emitted as an opaque filled rectangle, so a hairline frame, a translucent
   * wash, an ellipse and a rule all arrived in Canva as solid slabs.
   */
  shapes: Array<{ x: number; y: number; width: number; height: number; color: string;
    kind?: 'rect'|'roundRect'|'ellipse'|'line'; opacity?: number; radius?: number;
    rotation?: number; strokeWidth?: number; strokeColor?: string }>;
  logo?: { x: number; y: number; width: number; height: number };
  backgroundImage?: { bytes: Buffer; mimeType: 'image/png'|'image/jpeg' };
}
export interface TransferLogo { bytes: Buffer; sha256: string; mimeType: 'image/png'|'image/jpeg' }

/** Encodes a validated layout while taking factual copy exclusively from the saved request. */
export interface TransferOptions {
  /** Script typefaces admitted by the client reference pack. */
  extraFonts?: string[];
  /** Saved language metadata, indexed by exact copy. Omitted metadata means undetermined. */
  copyLocales?: readonly string[];
}

/** Validate before passing tags into DrawingML attributes; never derive language from script/font. */
export function resolveTransferLocales(copy: readonly string[], locales?: readonly string[]): string[] {
  if (locales === undefined) return copy.map(() => 'und');
  if (!Array.isArray(locales) || locales.length !== copy.length) throw new EditableTransferValidationError('Copy locales must match every exact-copy block');
  return Array.from(locales, locale => {
    if (typeof locale !== 'string' || locale.length > 63 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) {
      throw new EditableTransferValidationError('Invalid copy locale');
    }
    try { return Intl.getCanonicalLocales(locale)[0]; }
    catch { throw new EditableTransferValidationError('Invalid copy locale'); }
  });
}
export async function encodeEditableTransfer(plan: EditableTransferPlan, copy: string[], logo?: TransferLogo, options: TransferOptions = {}) {
  const copyLocales = resolveTransferLocales(copy, options.copyLocales);
  const hex = (color: string) => {
    let c = color.trim();
    if (/^#?[a-fA-F0-9]{3}$/.test(c)) {
      const raw = c.replace('#', '');
      c = `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
    }
    if (!/^#?[a-fA-F0-9]{6}$/.test(c)) throw new EditableTransferValidationError('Invalid color');
    return c.replace('#', '');
  };
  if (![plan.width,plan.height].every(n=>Number.isInteger(n)&&n>=320&&n<=4000)) throw new EditableTransferValidationError('Unsupported canvas dimensions');
  if (!copy.length || copy.length>40 || copy.some(t=>!t || t.length>10000)) throw new EditableTransferValidationError('Missing or excessive factual copy');
  if(plan.text.length!==copy.length || new Set(plan.text.map(t=>t.copyIndex)).size!==copy.length ||
    plan.text.some(t=>!Number.isInteger(t.copyIndex)||t.copyIndex<0||t.copyIndex>=copy.length)) throw new EditableTransferValidationError('Every exact-copy block must appear once');
  const bounds=(box:{x:number;y:number;width:number;height:number})=>{
    if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x<0||box.y<0||box.width<=0||box.height<=0||
      box.x+box.width>plan.width||box.y+box.height>plan.height)throw new EditableTransferValidationError('Layout exceeds canvas bounds');
  };
  for(const text of plan.text){bounds(text);hex(text.color);
    if(!isFontAdmitted(text.fontFamily, options)||!Number.isFinite(text.fontSize)||text.fontSize<12||text.fontSize>120)throw new EditableTransferValidationError('Unsupported font or unreadable size');
    if(!['left','center','right'].includes(text.align))throw new EditableTransferValidationError('Invalid text alignment');
  }
  for(let i=0;i<plan.text.length;i++)for(let j=i+1;j<plan.text.length;j++){
    const a=plan.text[i],b=plan.text[j];if(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y)throw new EditableTransferValidationError('Text boxes overlap');
  }
  if(plan.shapes.length>40)throw new EditableTransferValidationError('Excessive shapes');
  for(const shape of plan.shapes){bounds(shape);hex(shape.color);}
  if(logo&&!plan.logo)throw new EditableTransferValidationError('Required logo omitted');
  if(plan.logo){bounds(plan.logo);for(const t of plan.text)if(t.x<plan.logo.x+plan.logo.width&&t.x+t.width>plan.logo.x&&t.y<plan.logo.y+plan.logo.height&&t.y+t.height>plan.logo.y)throw new EditableTransferValidationError('Text overlaps logo');if(!logo)throw new EditableTransferValidationError('Requested logo is unavailable');
    if(createHash('sha256').update(logo.bytes).digest('hex')!==logo.sha256)throw new EditableTransferValidationError('Logo hash mismatch');}
  const pptx=new PptxGenJS();pptx.defineLayout({name:'HAWA',width:plan.width/96,height:plan.height/96});pptx.layout='HAWA';
  pptx.author='Hawa';pptx.subject='Editable Canva transfer; source copy is immutable';
  const slide=pptx.addSlide();slide.background={color:hex(plan.background)};
  if(plan.backgroundImage){
    slide.addImage({data:`${plan.backgroundImage.mimeType};base64,${plan.backgroundImage.bytes.toString('base64')}`,x:0,y:0,w:plan.width/96,h:plan.height/96});
  }
  for(const shape of plan.shapes){
    const kind=shape.kind||'rect';
    const transparency=shape.opacity!==undefined&&shape.opacity!==null?Math.round((1-shape.opacity)*100):0;
    const geom={x:shape.x/96,y:shape.y/96,w:shape.width/96,h:shape.height/96};
    const rotate = typeof shape.rotation === 'number' ? shape.rotation : 0;
    if(kind==='line'){
      // Mirrors the raster: a rule is a stroked line, not a filled box.
      slide.addShape(pptx.ShapeType.line,{...geom,h:0,rotate,
        line:{color:hex(shape.strokeColor||shape.color),width:Math.max(0.75,(shape.strokeWidth??Math.max(1,shape.height))*0.75),transparency}});
      continue;
    }
    const type=kind==='ellipse'?pptx.ShapeType.ellipse:kind==='roundRect'?pptx.ShapeType.roundRect:pptx.ShapeType.rect;
    slide.addShape(type,{...geom,rotate,
      fill:{color:hex(shape.color),transparency},
      line:shape.strokeColor?{color:hex(shape.strokeColor),width:Math.max(0.75,(shape.strokeWidth||1)*0.75),transparency:0}:{color:hex(shape.color),transparency:100},
      ...(kind==='roundRect'&&shape.radius?{rectRadius:shape.radius/96}:{})});
  }
  for(const t of plan.text){
    const textTransparency = t.opacity !== undefined && t.opacity !== null ? Math.round((1 - t.opacity) * 100) : 0;
    // The plan's tracking is em; pptxgenjs charSpacing is points, written as
    // spc="round(charSpacing * 100)" (hundredths of a point). Passing the em value raw sent a
    // 0.06em title to Canva as 0.06pt, about 0.08px where the preview drew 2.88px.
    const trackingEm = effectiveLetterSpacingEm(t);
    slide.addText(copy[t.copyIndex],{x:t.x/96,y:t.y/96,w:t.width/96,h:t.height/96,
      fontFace:t.fontFamily,fontSize:t.fontSize*.75,color:hex(t.color),transparency:textTransparency,
      ...(trackingEm ? { charSpacing: trackingEm * t.fontSize * 0.75 } : {}),
      align:t.rtl?'right':t.align,bold:t.bold||false,italic:t.italic||false,
      margin:0,lineSpacing:Math.round(t.fontSize*(t.lineHeight||1.4)*0.75*100)/100,breakLine:false,vertAnchor:'middle',paraSpaceAfterPt:0,fit:'resize',lang:copyLocales[t.copyIndex],...(t.rtl?{rtlMode:true}:{})});
  }
  if(plan.logo&&logo)slide.addImage({data:`${logo.mimeType};base64,${logo.bytes.toString('base64')}`,x:plan.logo.x/96,y:plan.logo.y/96,w:plan.logo.width/96,h:plan.logo.height/96});
  const bytes=await pptx.write({outputType:'nodebuffer'}) as Buffer;
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),manifest:{width:plan.width,height:plan.height,
    copy,copyLocales,copySha256:createHash('sha256').update(JSON.stringify(copy)).digest('hex'),logoSha256:logo?.sha256||null,plan,
    rtlBlocks:plan.text.filter(t=>t.rtl).map(t=>t.copyIndex),
    nativeVerification:'required',qaStatus:'not_run'}};
}
