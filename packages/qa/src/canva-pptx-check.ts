import { unzipSync,strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

/** Limited round-trip evidence. Does not certify logo pixels, geometry or print output. */
export function checkCanvaPptx(bytes:Uint8Array,expectedCopy:string[],requiredFont:string){
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
  find(doc,'p:sp',shapes);
  const texts:string[]=[],fonts:string[]=[];let unresolvedFont=false;
  for(const shape of shapes){
    const paragraphs:any[]=[];find(shape,'a:p',paragraphs);let text='';
    for(const paragraph of paragraphs){const nodes:any[]=[];find(paragraph,'a:t',nodes);text+=nodes.map(n=>n.map((x:any)=>String(x['#text']??'')).join('')).join('')+'\n';}
    if(!text.trim())continue;texts.push(text.trim());
    const runs:any[]=[];find(shape,'a:r',runs);
    if(!runs.length)unresolvedFont=true;
    for(const run of runs){const properties:any[]=[];find(run,'a:rPr',properties);let face:string|undefined;
      for(const props of properties)for(const child of props)if(child['a:latin'])face=child[':@']?.['@_typeface'];
      if(!face)unresolvedFont=true;else fonts.push(face);
    }
  }
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
  const copyPass=texts.length===expectedCopy.length&&texts.every((t,i)=>normalize(t)===normalize(expectedCopy[i]));
  const fontPass=!unresolvedFont&&fonts.length>0&&fonts.every(f=>f===requiredFont||f.startsWith(requiredFont+' '));
  return {checkVersion:1,source:'canva_exported_pptx',copyPass,fontPass,requiredFont,observedFonts:[...new Set(fonts)],textObjectCount:texts.length,
    expectedTextObjectCount:expectedCopy.length,comparisonPolicy:'exact words and punctuation; layout whitespace folded',
    fullReleasePass:false,logoVerification:'not_qualified',layoutVerification:'visual_review_required',printQualified:false};
}
