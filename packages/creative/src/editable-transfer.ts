import { createRequire } from 'node:module';
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs');
import { createHash } from 'node:crypto';

export interface EditableTransferPlan {
  width: number; height: number; background: string;
  text: Array<{ copyIndex: number; x: number; y: number; width: number; height: number;
    fontSize: number; fontFamily: string; color: string; align: 'left'|'center'|'right'; bold?: boolean;
    /** Right-to-left block (Sorani Kurdish): written with rtl="1", right alignment and lang="ku". Set by the server, never by the model. */
    rtl?: boolean }>;
  shapes: Array<{ x: number; y: number; width: number; height: number; color: string }>;
  logo?: { x: number; y: number; width: number; height: number };
}
export interface TransferLogo { bytes: Buffer; sha256: string; mimeType: 'image/png'|'image/jpeg' }

/** Encodes a validated layout while taking factual copy exclusively from the saved request. */
export interface TransferOptions { /** Script typefaces admitted by the client reference pack (for example the provisional Sorani font). */ extraFonts?: string[] }
export async function encodeEditableTransfer(plan: EditableTransferPlan, copy: string[], logo?: TransferLogo, options: TransferOptions = {}) {
  const hex = (color: string) => {
    let c = color.trim();
    if (/^#?[a-fA-F0-9]{3}$/.test(c)) {
      const raw = c.replace('#', '');
      c = `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
    }
    if (!/^#?[a-fA-F0-9]{6}$/.test(c)) throw new Error('Invalid color');
    return c.replace('#', '');
  };
  if (![plan.width,plan.height].every(n=>Number.isInteger(n)&&n>=320&&n<=4000)) throw new Error('Unsupported canvas dimensions');
  if (!copy.length || copy.length>40 || copy.some(t=>!t || t.length>10000)) throw new Error('Missing or excessive factual copy');
  if(plan.text.length!==copy.length || new Set(plan.text.map(t=>t.copyIndex)).size!==copy.length ||
    plan.text.some(t=>!Number.isInteger(t.copyIndex)||t.copyIndex<0||t.copyIndex>=copy.length)) throw new Error('Every exact-copy block must appear once');
  const fonts=['Arial','Georgia','Verdana','Times New Roman','Minion Variable Concept',...(options.extraFonts||[]).filter(f=>typeof f==='string'&&/^[A-Za-z0-9 ]{2,40}$/.test(f))];
  const bounds=(box:{x:number;y:number;width:number;height:number})=>{
    if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x<0||box.y<0||box.width<=0||box.height<=0||
      box.x+box.width>plan.width||box.y+box.height>plan.height)throw new Error('Layout exceeds canvas bounds');
  };
  for(const text of plan.text){bounds(text);hex(text.color);
    if(!fonts.includes(text.fontFamily)||!Number.isFinite(text.fontSize)||text.fontSize<12||text.fontSize>120)throw new Error('Unsupported font or unreadable size');
    if(!['left','center','right'].includes(text.align))throw new Error('Invalid text alignment');
  }
  for(let i=0;i<plan.text.length;i++)for(let j=i+1;j<plan.text.length;j++){
    const a=plan.text[i],b=plan.text[j];if(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y)throw new Error('Text boxes overlap');
  }
  if(plan.shapes.length>40)throw new Error('Excessive shapes');
  for(const shape of plan.shapes){bounds(shape);hex(shape.color);}
  if(logo&&!plan.logo)throw new Error('Required logo omitted');
  if(plan.logo){bounds(plan.logo);for(const t of plan.text)if(t.x<plan.logo.x+plan.logo.width&&t.x+t.width>plan.logo.x&&t.y<plan.logo.y+plan.logo.height&&t.y+t.height>plan.logo.y)throw new Error('Text overlaps logo');if(!logo)throw new Error('Requested logo is unavailable');
    if(createHash('sha256').update(logo.bytes).digest('hex')!==logo.sha256)throw new Error('Logo hash mismatch');}
  const pptx=new PptxGenJS();pptx.defineLayout({name:'HAWA',width:plan.width/96,height:plan.height/96});pptx.layout='HAWA';
  pptx.author='Hawa';pptx.subject='Editable Canva transfer; source copy is immutable';
  const slide=pptx.addSlide();slide.background={color:hex(plan.background)};
  for(const shape of plan.shapes)slide.addShape(pptx.ShapeType.rect,{x:shape.x/96,y:shape.y/96,w:shape.width/96,h:shape.height/96,
    fill:{color:hex(shape.color)},line:{color:hex(shape.color),transparency:100}});
  for(const t of plan.text)slide.addText(copy[t.copyIndex],{x:t.x/96,y:t.y/96,w:t.width/96,h:t.height/96,
    fontFace:t.fontFamily,fontSize:t.fontSize*.75,color:hex(t.color),align:t.rtl?'right':t.align,bold:t.bold||false,
    margin:0,lineSpacingMultiple:1.4,breakLine:false,vertAnchor:'top',paraSpaceAfterPt:0,fit:'resize',...(t.rtl?{rtlMode:true,lang:'ku'}:{})});
  if(plan.logo&&logo)slide.addImage({data:`${logo.mimeType};base64,${logo.bytes.toString('base64')}`,x:plan.logo.x/96,y:plan.logo.y/96,w:plan.logo.width/96,h:plan.logo.height/96});
  const bytes=await pptx.write({outputType:'nodebuffer'}) as Buffer;
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),manifest:{width:plan.width,height:plan.height,
    copy,copySha256:createHash('sha256').update(JSON.stringify(copy)).digest('hex'),logoSha256:logo?.sha256||null,plan,
    rtlBlocks:plan.text.filter(t=>t.rtl).map(t=>t.copyIndex),
    nativeVerification:'required',qaStatus:'not_run'}};
}
