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

/**
 * ADR-252 (friction 5): a greeting and a polite opener before the request ("Hi, we need …", "Hello!
 * Can you please make …", "Good morning, could you design …"). Only the first line, and only these
 * words: they never carry a deliverable or a fact.
 */
const GREETING=/^(?:(?:hi|hello|hey|hiya|dear\s+(?:team|all|office)|good\s+(?:morning|afternoon|evening|day)|salam|salaam|سڵاو|بەیانی\s+باش|ئێوارە\s+باش|ڕۆژباش)(?:\s+(?:there|team|all|everyone|guys))?\s*[,!.،:;-]*\s+)+/iu;
const POLITE='(?:(?:please|kindly|pls)\\s+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+|kindly\\s+)?|(?:we|i)\\s+would\\s+like\\s+(?:you\\s+)?to\\s+|(?:we|i)\\s+(?:want|need)\\s+you\\s+to\\s+)?';

/**
 * Live 2026-10-02 (canary chat): "make a Canary Test poster for the Autumn Fair …, and also a flyer for the
 * Book Club …" stayed one request: a client's name stood between the article and the format. The name is
 * set aside only to read the format; the piece keeps its words. Case-sensitive on purpose: under `iu`,
 * \p{Lu} matches any letter ("put the poster" is not a name).
 */
const NAME_AFTER_ARTICLE=/^((?:an?|the)\s+)(?:\p{Lu}[\p{L}\p{N}&'’-]*\s+){1,3}(?=(?:(?:instagram|facebook|square|landscape)\s+)?(?:poster|story|post|flyer|banner|invitation|thumbnail)(?![\p{L}\p{N}_]))/u;
const unnamed=(piece:string)=>piece.replace(NAME_AFTER_ARTICLE,'$1');

export function planRequestDeliverables(raw:string):RequestDeliverables {
  const source=String(raw||'').trim();
  const lead=GREETING.exec(source)?.[0] ?? '';
  const text=source.slice(lead.length);
  const countPattern=new RegExp(`^${POLITE}(?:we\\s+(?:need|want)|i\\s+(?:need|want)|make|create|design|prepare|دەمانەوێت|دەمەوێت|پێویستمان\\s+بە|تکایە)\\s+([\\d٠-٩۰-۹]+|two|three|four|five|six|seven|eight|nine|ten|دوو|سێ|چوار|پێنج|شەش|حەوت|هەشت)\\s+(?:(?:different|separate|distinct)\\s+)?(?:designs?|posters?|graphics?|versions?|variations?|layouts?|دیزاین(?:ەکان)?|پۆستەر(?:ەکان)?|گرافیک)(?![\\p{L}\\p{N}_])`,'iu');
  const match=countPattern.exec(text);
  if (!match) {
    // Explicit formats authorize their own deliverables, without also requiring a numeric count.
    const command=new RegExp(`^${POLITE}(?:make|create|design|prepare|we\\s+(?:need|want|would\\s+like)|i\\s+(?:need|want|would\\s+like))\\s+`,'iu').exec(text);
    if (!command) return {kind:'single'};
    const body=text.slice(command[0].length);
    if (copyMarker.test(body)) return {kind:'single'};
    // ADR-252: ", and also a flyer …" and "; also a story …" separate deliverables as "and" does.
    const pieces=body.split(new RegExp(`(?:,?\\s+(?:and|&)\\s+(?:also\\s+)?|[,;]\\s*(?:also\\s+)?)(?=${ROLE})`,'giu')).map(p=>p.trim());
    if (pieces.length<2 || !pieces.every(p=>new RegExp(`^${ROLE}`,'iu').test(unnamed(p)))) return {kind:'single'};
    // "… for the open day, the flyer we sent last week had the wrong date" names an earlier design, not
    // another one asked for.
    if (pieces.slice(1).some(p=>new RegExp(`^the\\s+${ROLE}`,'iu').test(unnamed(p)) && !new RegExp(`^${ROLE}\\s+(?:for|about)\\s+\\S`,'iu').test(unnamed(p))))
      return {kind:'single'};
    if (pieces.length>MAX_REQUEST_DELIVERABLES) return {kind:'limit',count:pieces.length};
    const roleOnly=new RegExp(`^${ROLE}$`,'iu');
    const commonFormats=pieces.slice(0,-1).every(p=>roleOnly.test(p));
    const lastRole=new RegExp(`^${ROLE}`,'iu').exec(unnamed(pieces.at(-1)!))![0];
    const suffix=unnamed(pieces.at(-1)!).slice(lastRole.length);
    const explicitSubjects=pieces.every(p=>new RegExp(`^${ROLE}\\s+(?:for|about)\\s+\\S`,'iu').test(unnamed(p)));
    return {kind:'multiple',count:pieces.length,shared:(lead+command[0]).trim(),parts:pieces.map((p,i)=>({
      text:commonFormats && i<pieces.length-1 ? p+suffix : p,variant:requestedDeliverableVariant(p),
      ...(!commonFormats && !explicitSubjects ? {detailsRequired:true as const} : {})}))};
  }
  const token=digits(match[1].toLowerCase()),count=NUMBER_WORDS[token]??Number(token);
  if (count>MAX_REQUEST_DELIVERABLES) return {kind:'limit',count:Number.isFinite(count) ? count : Number.MAX_SAFE_INTEGER};
  if (!Number.isSafeInteger(count)||count<2) return {kind:'single'};
  const rest=text.slice(match[0].length),colon=rest.indexOf(':'),line=rest.indexOf('\n');
  const header=lead+(colon>=0 && (line<0||colon<line) ? match[0]+rest.slice(0,colon+1) : match[0]);
  const body=(header.length>lead.length+match[0].length ? rest.slice(colon+1) : rest).trim();
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
