import { CanvaFlowError } from './canva-flow-error.js';
import { isCopyIntroducer, isDesignerRemark, peelTrailingRemarks } from './request-remarks.js';

/**
 * Only labelled, separately saved Desk fields establish a language. Historical exactCopy.language
 * was often guessed from script (including Arabic labelled ckb), so it is not authority here.
 * Require identical copy and order: legacy cleanup or a revision must not inherit a stale label.
 */
export function savedDesignCopyLocales(payload: unknown, copy: readonly string[]): string[] {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const outer = object(payload);
  const p = object(outer.payload || outer);
  const body = object(p.body || p);
  const unknown = () => copy.map(() => 'und');
  if (object(p.reviewedSource).confirmation === 'request_copy_reviewed') {
    const source = object(p.reviewedSource);
    if (source.origin !== 'customer_exact_copy' || source.localesConfirmedByRequester !== true || !Array.isArray(body.exactCopy)) return unknown();
    const blocks = body.exactCopy.map(object);
    if (blocks.length !== copy.length || blocks.some((block,i) => block.text !== copy[i] || !['en','ckb','ar'].includes(String(block.language)))) return unknown();
    return blocks.map(block => String(block.language));
  }
  const fields = object(p.sourceDocument).confirmation === 'request_copy_reviewed'
    ? ['copyEn', 'copyCkb']
    : deskSeparatedCopy(body) ? ['headlineEn', 'copyEn', 'headlineCkb', 'copyCkb'] : [];
  const labelled = fields.filter(key => typeof body[key] === 'string' && (body[key] as string).trim())
    .map(key => ({ text: body[key], locale: key.endsWith('Ckb') ? 'ckb' : 'en' }));
  if (labelled.length !== copy.length || labelled.some((block, i) => block.text !== copy[i])) return unknown();
  return labelled.map(block => block.locale);
}

/**
 * A request whose copy the Desk form separated from its instructions at entry: a designer-owned Desk
 * task (`canva_manual`) or, since ADR-287, a Desk "New task" opened on RequestLifecycle (`office_request`).
 */
export function deskSeparatedCopy(body: Record<string, unknown>): boolean {
  return body.workflow === 'canva_manual' || body.workflow === 'office_request';
}

const ENVELOPE_CLOSE:Record<string,string>={'(':')','[':']','{':'}','"':'"','\u201C':'\u201D','\u00AB':'\u00BB'};
/**
 * Copy the requester wrapped in brackets or quotes, with a remark after the closing mark:
 * "( ...copy... ) make sure you do a new pro design" (task b6621947, 2026-09-18) put a lone "(" in
 * the title and the remark in the footer. The marks are not copy and the remark is an instruction.
 * Unwrapped only when the pair encloses more than one paragraph and what follows is one remark, so
 * copy that merely starts with "(Draft)" or "(1)" is left exactly as written.
 */
export function unwrapCopyEnvelope(text:string):{copy:string;trailing:string} {
  const s=String(text||'').trim(),open=s[0],close=ENVELOPE_CLOSE[open];
  if(!close)return {copy:s,trailing:''};
  let end=-1;
  if(close===open){end=s.lastIndexOf(close);if(end===0)end=-1;}
  else{let depth=0;for(let i=0;i<s.length;i++){if(s[i]===open)depth++;else if(s[i]===close&&--depth===0){end=i;break;}}}
  if(end<0)return {copy:s,trailing:''};
  const inner=s.slice(1,end).trim(),trailing=s.slice(end+1).trim();
  // The pair wraps the copy only if it encloses more than one paragraph, and what follows is one remark.
  if(!/\n\s*\n/.test(inner)||/\n\s*\n/.test(trailing))return {copy:s,trailing:''};
  return {copy:inner,trailing};
}

/**
 * Emoji typed into a brief ("📍 Erbil", "📅 25 September"). The transfer cannot set them and the
 * whole request was refused as COPY_UNSUPPORTED, so an ordinary office brief never got a draft
 * (2026-09-23 review). They are decoration, not copy: the words around them are kept exactly.
 */
export function withoutEmoji(text:string):string{
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{E0020}-\u{E007F}][\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]*/gu,'')
    .replace(/\u200D(?=\s|$)/gu,'')
    .split('\n').map(line=>line.replace(/[ \t]{2,}/g,' ').trim()).join('\n')
    .trim();
}

export function savedDesignCopy(payload:any,description:string):{copy:string[];instructions:string} {
  // ADR-071: server-confirmed Desk copy is already separated from source evidence/instructions.
  // Do not apply the legacy chat divider/remark/emoji cleanup to explicitly reviewed strings.
  const p=payload?.payload||payload||{},body=p.body||p;
  if(p.reviewedSource?.confirmation==='request_copy_reviewed'){
    const copy=(body.exactCopy as Array<{text?:unknown}>|undefined)?.map(block=>block.text)
      .filter((text):text is string=>typeof text==='string'&&Boolean(text.trim())) || [];
    if(!copy.length)throw new CanvaFlowError(422,'COPY_REQUIRED','The reviewed source request has no exact copy.');
    return {copy,instructions:typeof body.designInstructions==='string'?body.designInstructions:''};
  }
  if(p.sourceDocument?.confirmation==='request_copy_reviewed'){
    const copy=[body.copyEn,body.copyCkb].filter((text):text is string=>typeof text==='string'&&Boolean(text.trim()));
    if(!copy.length)throw new CanvaFlowError(422,'COPY_REQUIRED','The reviewed PDF request has no exact copy.');
    return {copy,instructions:typeof body.designInstructions==='string'?body.designInstructions:''};
  }
  if(deskSeparatedCopy(body)){
    // Desk separates copy from instructions at entry. A queue title is metadata, not a headline.
    // Preserve both current copy fields and explicit headlines on older saved Desk requests.
    const fields=[body.headlineEn,body.copyEn,body.headlineCkb,body.copyCkb];
    if(fields.some(text=>text!==undefined&&text!==null&&typeof text!=='string'))
      throw new CanvaFlowError(422,'COPY_REQUIRED','The saved Desk request has invalid exact copy fields.');
    const copy=fields.filter((text):text is string=>typeof text==='string'&&Boolean(text.trim()));
    if(!copy.length)throw new CanvaFlowError(422,'COPY_REQUIRED','The saved Desk request has no exact copy.');
    return {copy,instructions:typeof body.designInstructions==='string'?body.designInstructions:''};
  }
  const saved=savedDesignCopyAsSent(payload,description);
  const copy=saved.copy.map(withoutEmoji).filter(Boolean);
  if(!copy.length)throw new CanvaFlowError(422,'COPY_REQUIRED','The request carries no design copy apart from emoji. Send the exact text to set; no placeholder copy will be invented.');
  return {...saved,copy};
}

function savedDesignCopyAsSent(payload:any,description:string):{copy:string[];instructions:string} {
  const p=payload?.payload||payload||{},body=p.body||p;
  const raw:string=typeof p.rawRequestText==='string'?p.rawRequestText:description;
  // ADR-233: a fresh round's words are art direction; its copy is the request's, never read from them.
  const divider=p.studioOptions?.freshFrom?null:raw?.match(/\n\s*[_\-=*]{3,}\s*\n/);
  if(divider?.index!==undefined){
    let instructions=raw.slice(0,divider.index).trim();
    const explicit=String(p.designInstructions||body.designInstructions||'').trim();
    if(explicit&&explicit!==instructions&&(explicit.includes('Operator Revision Directive:')||!instructions)){
      instructions=explicit;
    }
    const envelope=unwrapCopyEnvelope(raw.slice(divider.index+divider[0].length));
    if(envelope.trailing)instructions=[instructions,envelope.trailing].filter(Boolean).join('\n');
    // A closing remark to the designer ("I attached the pictures…") is an instruction, as at intake.
    const peeled=peelTrailingRemarks(envelope.copy);
    if(peeled.remarks)instructions=[instructions,peeled.remarks].filter(Boolean).join('\n');
    const copy=peeled.copy.split(/\n\s*\n/).map(t=>t.trim()).filter(Boolean);
    // A divider with nothing after it is a request without copy, not copy the transfer cannot set.
    if(!copy.length)throw new CanvaFlowError(422,'COPY_REQUIRED','Nothing follows the divider, so the request carries no design copy. Send the exact text to set; no placeholder copy will be invented.');
    return {instructions,copy};
  }
  const blocks=body.copyBlocks||p.exactCopy;
  if(Array.isArray(blocks)&&blocks.length&&blocks.every(b=>typeof b.text==='string'&&b.text.trim())){
    // Requests saved before 2026-09-22 kept a closing remark to the designer ("I attached the
    // panelists pictures and a reference for the graphic") as their last copy block. It is read as
    // an instruction here, by the same rule intake now applies, so those requests are fixed too.
    let texts=blocks.map(b=>b.text);
    const remarks:string[]=[];
    while(texts.length>1&&isDesignerRemark(texts[texts.length-1]))remarks.unshift(texts.pop()!.trim());
    // Requests saved before 2026-09-29 (task ba4469f2, the owner's report cover) kept the line that
    // introduces the text ("Here is the text and the photos:") as copy block 0, and the lines after it
    // in paragraphs. It is an instruction, and each line after it one block, by the rule intake now
    // applies (ADR-142), so a design made again of such a request prints only the requester's text.
    const introducer=texts.length>1&&!texts[0].trim().includes('\n')&&isCopyIntroducer(texts[0])?texts[0].trim():null;
    if(introducer)texts=texts.slice(1).flatMap((text:string)=>text.split('\n').map((line:string)=>line.trim()).filter(Boolean));
    const instructions=[String(p.designInstructions||body.designInstructions||''),introducer,...remarks].filter(Boolean).join('\n');
    return {copy:texts,instructions};
  }
  if(body.headlineEn&&typeof body.copyEn==='string')return {copy:[body.headlineEn,body.copyEn].filter(Boolean),instructions:String(body.designInstructions||'')};
  throw new CanvaFlowError(422,'COPY_REQUIRED','Separate the exact design copy from instructions before generating. No placeholder copy will be invented.');
}

/** Scripts the transfer can set: Latin (English) and Arabic script (Sorani Kurdish). Everything else is refused honestly. */
export function classifyCopyScript(text:string):'latin'|'arabic'|'unsupported'{
  if(/[^\u0009\u000A\u000D\u0020-\u024F\u02B0-\u02FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF\u2200-\u22FF\u25A0-\u25FF\u2600-\u27BF\uFE0F]/.test(text))return 'unsupported';
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)?'arabic':'latin';
}
