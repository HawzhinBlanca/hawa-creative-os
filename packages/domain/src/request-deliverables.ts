/** Bounded, source-preserving intake policy. It authorizes neither provider calls nor factual edits. */
export const MAX_REQUEST_DELIVERABLES = 8;
/** An adapter update, or its separately acknowledged request-owned child note. */
export function isLateChangeReceiptId(value:unknown):value is string {
  return typeof value==='string' && /^[1-9][0-9]{0,18}(?::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(value);
}
export interface RequestDeliverable {
  text: string;
  variant?: {width:number;height:number};
  detailsRequired?: true;
}
export type RequestDeliverables = {kind:'single'} | {kind:'limit';count:number} |
  {kind:'multiple';count:number;shared:string;parts:RequestDeliverable[]};

const NUMBER_WORDS:Record<string,number>={two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  'دوو':2,'سێ':3,'چوار':4,'پێنج':5,'شەش':6,'حەوت':7,'هەشت':8};
const digits=(s:string)=>s.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c>='۰'?0x6f0:0x660)));
const ROLE='(?:(?:an?|the)\\s+)?(?:(?:instagram|facebook|square|landscape)\\s+)?(?:poster|story|post|flyer|banner|invitation|thumbnail|پۆستەر|ستۆری|پۆست|بانەر)(?![\\p{L}\\p{N}_])';
const copyMarker=/(?:^|\n)\s*(?:copy|text|content|wording|دەق|ناوەڕۆک)\s*[:：]/iu;

/** An explicit format outranks a client default; factual words after a copy marker never set a size. */
export function requestedDeliverableVariant(text:string):RequestDeliverable['variant'] {
  const marker=copyMarker.exec(text),policy=marker ? text.slice(0,marker.index) : text;
  const size=/(?:^|\n)\s*(?:size|dimensions|canvas|قەبارە)\s*[:：]?\s*(\d{1,8})\s*[x×]\s*(\d{1,8})\b/iu.exec(digits(policy));
  if (size)
    return {width:Number(size[1]),height:Number(size[2])};
  const role=policy.split(/\b(?:for|about|copy|text)\b|\n/iu)[0];
  if (/\b(?:instagram\s+)?story\b|ستۆری/iu.test(role)) return {width:1080,height:1920};
  if (/\bsquare\b/iu.test(role)) return {width:1080,height:1080};
  if (/\blandscape\b/iu.test(role)) return {width:1920,height:1080};
  return undefined; // A generic poster keeps the client's selected default.
}

export function planRequestDeliverables(raw:string):RequestDeliverables {
  const text=String(raw||'').trim();
  const countPattern=/^(?:(?:please|kindly)\s+)?(?:we\s+(?:need|want)|i\s+(?:need|want)|make|create|design|prepare|(?:can|could)\s+you\s+(?:make|create|design)|دەمانەوێت|دەمەوێت|پێویستمان\s+بە|تکایە)\s+([\d٠-٩۰-۹]+|two|three|four|five|six|seven|eight|nine|ten|دوو|سێ|چوار|پێنج|شەش|حەوت|هەشت)\s+(?:(?:different|separate|distinct)\s+)?(?:designs?|posters?|graphics?|versions?|variations?|layouts?|دیزاین(?:ەکان)?|پۆستەر(?:ەکان)?|گرافیک)(?![\p{L}\p{N}_])/iu;
  const match=countPattern.exec(text);
  if (!match) {
    // Explicit formats authorize their own deliverables, without also requiring a numeric count.
    const command=/^(?:(?:please|kindly)\s+)?(?:make|create|design|we\s+need|i\s+need)\s+/iu.exec(text);
    if (!command) return {kind:'single'};
    const body=text.slice(command[0].length);
    if (copyMarker.test(body)) return {kind:'single'};
    const pieces=body.split(new RegExp(`(?:,?\\s+(?:and|&)\\s+|[,;]\\s*)(?=${ROLE})`,'giu')).map(p=>p.trim());
    if (pieces.length<2 || !pieces.every(p=>new RegExp(`^${ROLE}`,'iu').test(p))) return {kind:'single'};
    if (pieces.length>MAX_REQUEST_DELIVERABLES) return {kind:'limit',count:pieces.length};
    const roleOnly=new RegExp(`^${ROLE}$`,'iu');
    const commonFormats=pieces.slice(0,-1).every(p=>roleOnly.test(p));
    const lastRole=new RegExp(`^${ROLE}`,'iu').exec(pieces.at(-1)!)![0];
    const suffix=pieces.at(-1)!.slice(lastRole.length);
    const explicitSubjects=pieces.every(p=>new RegExp(`^${ROLE}\\s+(?:for|about)\\s+\\S`,'iu').test(p));
    return {kind:'multiple',count:pieces.length,shared:command[0].trim(),parts:pieces.map((p,i)=>({
      text:commonFormats && i<pieces.length-1 ? p+suffix : p,variant:requestedDeliverableVariant(p),
      ...(!commonFormats && !explicitSubjects ? {detailsRequired:true as const} : {})}))};
  }
  const token=digits(match[1].toLowerCase()),count=NUMBER_WORDS[token]??Number(token);
  if (count>MAX_REQUEST_DELIVERABLES) return {kind:'limit',count:Number.isFinite(count) ? count : Number.MAX_SAFE_INTEGER};
  if (!Number.isSafeInteger(count)||count<2) return {kind:'single'};
  const rest=text.slice(match[0].length),colon=rest.indexOf(':'),line=rest.indexOf('\n');
  const header=colon>=0 && (line<0||colon<line) ? match[0]+rest.slice(0,colon+1) : match[0];
  const body=(header.length>match[0].length ? rest.slice(colon+1) : rest).trim();
  const protectedCopy=copyMarker.exec(body);
  const boundary=protectedCopy?.index??body.length;
  const numbered=new RegExp(`(?:^|\\n)[ \\t]*([1-8١-٨۱-۸])[.)]\\s+(?=${ROLE})`,'giu');
  const markers=[...body.matchAll(numbered)].filter(m=>m.index<boundary);
  let pieces:string[]=[];
  let common='';
  if (markers.length===count && markers.every((m,i)=>Number(digits(m[1]))===i+1)) {
    common=body.slice(0,markers[0].index).trim();
    pieces=markers.map((m,i)=>body.slice(m.index+m[0].length,markers[i+1]?.index??body.length).trim());
  } else if (!markers.length && !protectedCopy) {
    const connector=new RegExp(`(?:,?\\s+(?:and|&)\\s+|،?\\s+و\\s+|[,;،؛]\\s*|\\n\\s*)(?=${ROLE})`,'giu');
    pieces=body.split(connector).map(p=>p.trim());
  }
  if (pieces.length===count && pieces.every(p=>new RegExp(`^${ROLE}`,'iu').test(p)))
    return {kind:'multiple',count,shared:header,parts:pieces.map(p=>({text:common ? `${common}\n${p}` : p,variant:requestedDeliverableVariant(p)}))};
  // All source words remain available. Guessing which facts belong to which design is not authorized.
  const ambiguous=!body || markers.length>0 || pieces.length>1 ||
    /\b(?:one\s+for|other\s+for|first|second|respectively)\b/iu.test(body);
  return {kind:'multiple',count,shared:header,parts:Array.from({length:count},()=>({text:body,
    variant:requestedDeliverableVariant(body),...(ambiguous ? {detailsRequired:true as const} : {})}))};
}

/** An operating name from the user's own subject; submitted copy is never changed. */
export function requestOperatingSubject(raw:string,headline:string):string|undefined {
  if (headline && !/^(?:date|time|venue|location|address|contact|rsvp)\s*[:：]|^(?:بەروار|کات|شوێن)\s*[:：]/iu.test(headline) &&
      !new RegExp(`^${ROLE}\\s+for\\b`,'iu').test(headline)) return undefined;
  const subject=/(?:\b(?:make|create|design)\b|\b(?:an?\s+)?(?:instagram\s+)?(?:poster|story|flyer|invitation)\b)[^\n]*?\bfor\s+(?:the\s+)?([^\n]+?)(?=\s+(?:on|at)\s+|[.!?]?(?:\n|$))/iu;
  const divider=/\n\s*[_\-=*]{3,}\s*\n/u.exec(raw);
  for (const source of [headline,divider ? raw.slice(divider.index+divider[0].length) : raw,raw]) {
    const match=subject.exec(source);
    if (match?.[1].trim()) return match[1].trim();
  }
  return undefined;
}
