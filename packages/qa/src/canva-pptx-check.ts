import { unzipSync,strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

/** Limited round-trip evidence. Does not certify logo pixels, geometry or print output. */
export interface PptxCheckOptions { /** Typeface expected on Arabic-script (Sorani) text objects; Latin objects must use requiredFont. */ scriptFonts?: { arabic?: string } }
const ARABIC_SCRIPT=/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export function checkCanvaPptx(bytes:Uint8Array,expectedCopy:string[],requiredFont:string,options:PptxCheckOptions={}){
  if(bytes.length>25*1024*1024)throw new Error('PPTX exceeds import limit');
  let total=0,count=0;const seen=new Set<string>();
  const files=unzipSync(bytes,{filter:file=>{
    if(++count>500||seen.has(file.name)||file.name.includes('..')||file.name.startsWith('/'))throw new Error('Unsupported ZIP directory');
    seen.add(file.name);total+=file.originalSize;
    if(file.originalSize>8*1024*1024||total>64*1024*1024)throw new Error('Expanded PPTX exceeds inspection limit');
    return /^ppt\/slides\/slide\d+\.xml$/.test(file.name)||file.name==='ppt/presentation.xml';
  }});
  const names=Object.keys(files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n));
  if(names.length!==1||!files['ppt/presentation.xml'])throw new Error('Only one-page PPTX is admitted');
  const parser=new XMLParser({preserveOrder:true,ignoreAttributes:false,trimValues:false,parseTagValue:false,processEntities:true});
  const parse=(b:Uint8Array)=>{const text=strFromU8(b);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('XML entities are forbidden');return parser.parse(text);};
  const doc=parse(files[names[0]]),shapes:any[]=[];
  const find=(node:any,tag:string,found:any[])=>{if(Array.isArray(node)){for(const item of node)find(item,tag,found);}else if(node&&typeof node==='object'){for(const [key,value]of Object.entries(node)){if(key===tag)found.push(value);else if(key!==':@')find(value,tag,found);}}};
  const findOwners=(node:any,tag:string,found:any[])=>{if(Array.isArray(node)){for(const item of node)findOwners(item,tag,found);}else if(node&&typeof node==='object'){if(Object.prototype.hasOwnProperty.call(node,tag))found.push(node);for(const value of Object.values(node))findOwners(value,tag,found);}};
  find(doc,'p:sp',shapes);
  const texts:string[]=[],fonts:string[]=[],fontExpectations:string[]=[];let unresolvedFont=false;let arabicObjects=0,rtlObjects=0;
  for(const shape of shapes){
    const paragraphs:any[]=[];find(shape,'a:p',paragraphs);let text='';
    for(const paragraph of paragraphs){
      const nodes:any[]=[];find(paragraph,'a:t',nodes);
      for(const n of nodes){
        if(Array.isArray(n))text+=n.map((x:any)=>String(x?.['#text']??'')).join('');
        else if(n&&typeof n==='object')text+=String(n['#text']??'');
        else if(typeof n==='string')text+=n;
      }
      text+='\n';
    }
    if(!text.trim())continue;texts.push(text.trim());
    const arabic=ARABIC_SCRIPT.test(text);const expectedFont=arabic&&options.scriptFonts?.arabic?options.scriptFonts.arabic:requiredFont;
    if(arabic){arabicObjects++;const owners:any[]=[];findOwners(shape,'a:pPr',owners);
      if(owners.some(o=>String(o?.[':@']?.['@_rtl']??'')==='1'))rtlObjects++;}
    const runs:any[]=[];find(shape,'a:r',runs);
    if(!runs.length)unresolvedFont=true;
    for(const run of runs){
      const properties:any[]=[];find(run,'a:rPr',properties);
      const runFaces:string[]=[];
      const inspectChild=(child:any)=>{
        if(!child||typeof child!=='object')return;
        for(const tag of ['a:latin','a:cs','a:ea']){
          if(child[tag]){
            const tf=child[':@']?.['@_typeface']||(child[tag]as any)?.['@_typeface'];
            if(tf&&typeof tf==='string'&&tf.trim())runFaces.push(tf.trim());
          }
        }
      };
      for(const props of properties){
        if(Array.isArray(props)){for(const child of props)inspectChild(child);}
        else if(props&&typeof props==='object'){inspectChild(props);}
      }
      if(!runFaces.length){unresolvedFont=true;}
      else{
        const matched=runFaces.find(f=>f===expectedFont||f.startsWith(expectedFont+' '));
        fonts.push(matched||runFaces[0]);fontExpectations.push(expectedFont);
      }
    }
  }
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
  const copyPass=texts.length===expectedCopy.length&&texts.every((t,i)=>normalize(t)===normalize(expectedCopy[i]));
  const fontPass=!unresolvedFont&&fonts.length>0&&fonts.every((f,i)=>f===fontExpectations[i]||f.startsWith(fontExpectations[i]+' '));
  const rtlPass=arabicObjects===0||rtlObjects===arabicObjects;
  const rtlNote=arabicObjects>0&&rtlObjects===0?'Paragraph rtl attribute absent: Canva exports omit it, so reading direction is verified visually, not here.':null;
  return {checkVersion:2,source:'canva_exported_pptx',copyPass,fontPass,rtlPass,rtlNote,requiredFont,scriptFonts:options.scriptFonts||null,arabicTextObjectCount:arabicObjects,rtlTextObjectCount:rtlObjects,observedFonts:[...new Set(fonts)],textObjectCount:texts.length,
    expectedTextObjectCount:expectedCopy.length,comparisonPolicy:'exact words and punctuation; layout whitespace folded',
    fullReleasePass:false,logoVerification:'not_qualified',layoutVerification:'visual_review_required',printQualified:false};
}
