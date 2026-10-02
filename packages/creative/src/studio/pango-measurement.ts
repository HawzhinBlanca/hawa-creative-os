import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { fontFileInventory, pinnedFontconfigFile, pinnedSystemFontFiles, rasteriserEnv } from './font-environment.js';

const helper=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../bin/text-measure');
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const finite=z.number().finite();
const identitySchema=z.object({version:z.literal(1),runtime:z.string().min(1).max(512)}).strict();
const outputSchema=identitySchema.extend({lines:z.array(z.object({
  text:z.string(),width:finite.nonnegative(),
  ink:z.object({x:finite,y:finite,width:finite.nonnegative(),height:finite.nonnegative()}).strict(),
  unknownGlyphs:z.number().int().nonnegative(),
  missingCodePoints:z.array(z.number().int().min(0).max(0x10ffff)).max(16384),
  fonts:z.array(z.object({file:z.string().min(1),index:z.number().int().nonnegative()}).strict()).max(16384),
}).strict()).min(1).max(512)}).strict();

export interface MeasurementRuntimeIdentity {version:1;binarySha256:string;runtime:string}
let identityMemo:{fingerprint:string;value:MeasurementRuntimeIdentity}|undefined;
/** Build output is immutable during a process lifetime; byte changes always invalidate it. */
export function measurementRuntimeIdentity():MeasurementRuntimeIdentity {
  const bytes=fs.readFileSync(helper),binarySha256=digest(bytes);
  const fingerprint=JSON.stringify([binarySha256,process.env.LC_ALL,process.env.LC_CTYPE,process.env.LANG,process.env.LANGUAGE]);
  if(identityMemo?.fingerprint===fingerprint)return {...identityMemo.value};
  const result=identitySchema.parse(JSON.parse(execFileSync(helper,['--identity'],{encoding:'utf8',timeout:3000,maxBuffer:4096})));
  const value={...result,binarySha256};identityMemo={fingerprint,value};return {...value};
}

export interface PangoMeasurementInput {
  text:string;family:string;size:number;width:number;spacingPx:number;rtl:boolean;bold:boolean;italic:boolean;fontsDir:string;
  /** ADR-275: a CSS weight (100..900) to shape at, in place of bold/regular. */
  weight?:number;
}
export interface PangoMeasuredLine {
  text:string;width:number;ink:{x:number;y:number;width:number;height:number};unknownGlyphs:number;
  missingCodePoints:number[];
  fonts:Array<{name:string;sha256:string;index:number}>;
}
export interface PangoMeasurement {
  method:'pango-wrap-v1';inputSha256:string;runtime:MeasurementRuntimeIdentity;lines:PangoMeasuredLine[];
}
const cache=new Map<string,{value:PangoMeasurement;bytes:number}>();
let cacheBytes=0;

/** One process shapes all candidate wraps; copy travels on stdin, never in a shell command. */
export function measurePangoText(input:PangoMeasurementInput):PangoMeasurement {
  const {family,size,width,spacingPx,rtl,bold,italic,fontsDir,weight}=input;
  if(weight!==undefined && (!Number.isInteger(weight) || weight<100 || weight>1000))throw new Error('PANGO_MEASUREMENT_INVALID_INPUT');
  if(!family || /[\r\n\0]/.test(family) || Buffer.byteLength(family)>256 || input.text.includes('\0') || Buffer.from(input.text).toString('utf8')!==input.text ||
      ![size,width,spacingPx].every(Number.isFinite) || size<1 || size>4096 || width<=0 || width>1000000 || Math.abs(spacingPx)>4096)
    throw new Error('PANGO_MEASUREMENT_INVALID_INPUT');
  const normalized=input.text.split('\n').map(p=>p.trim().split(/\s+/).filter(Boolean).join(' ')).join('\n');
  const stdin=`${family}\n${normalized}`;
  if(Buffer.byteLength(stdin)>16384 || normalized.split(/\s+/).length>2048 || normalized.split('\n').length>512)
    throw new Error('PANGO_MEASUREMENT_INPUT_LIMIT');
  const runtime=measurementRuntimeIdentity();
  const system=pinnedSystemFontFiles();
  const inventory=fontFileInventory(fontsDir,system);
  const basis={method:'pango-wrap-v1' as const,text:input.text,family,size,width,spacingPx,rtl,bold,italic,...(weight!==undefined?{weight}:{}),inventory,runtime};
  const inputSha256=digest(JSON.stringify(basis));
  // Include location in memory caching: two equal inventories must still use their own config.
  const key=`${path.resolve(fontsDir)}:${inputSha256}`;
  const existing=cache.get(key);if(existing)return structuredClone(existing.value);
  const config=pinnedFontconfigFile(fontsDir,system);
  // The fifth argument is 0/1 for regular/bold, or (ADR-275) a CSS weight from 100.
  const raw=execFileSync(helper,[String(size),String(width),String(spacingPx),rtl?'1':'0',weight!==undefined?String(weight):bold?'1':'0',italic?'1':'0'],
    {input:stdin,encoding:'utf8',env:rasteriserEnv(config),timeout:3000,maxBuffer:2*1024*1024});
  const parsed=outputSchema.parse(JSON.parse(raw));
  if(parsed.runtime!==runtime.runtime)throw new Error('PANGO_MEASUREMENT_RUNTIME_CHANGED');
  const admitted=new Map(inventory.map(file=>{
    const absolute=file.name.startsWith('package/')?path.join(fontsDir,file.name.slice(8)):file.name.slice(7);
    return [fs.realpathSync(absolute),file] as const;
  }));
  const lines=parsed.lines.map(line=>({...line,fonts:[...new Map(line.fonts.map(font=>{
    const known=admitted.get(fs.realpathSync(font.file));
    if(!known || digest(fs.readFileSync(font.file))!==known.sha256)throw new Error('PANGO_MEASUREMENT_UNPINNED_FONT');
    const identified={...known,index:font.index};return [`${known.name}:${font.index}`,identified] as const;
  })).values()]}));
  if(JSON.stringify(fontFileInventory(fontsDir,system))!==JSON.stringify(inventory))throw new Error('PANGO_MEASUREMENT_FONTS_CHANGED');
  // Assert wrapping did not insert, remove or reorder any normalized word.
  if(lines.map(l=>l.text).join(' ').split(/\s+/).filter(Boolean).join(' ')!==normalized.split(/\s+/).filter(Boolean).join(' '))
    throw new Error('PANGO_MEASUREMENT_COPY_CHANGED');
  const value:PangoMeasurement={method:'pango-wrap-v1',inputSha256,runtime,lines};
  const bytes=Buffer.byteLength(JSON.stringify(value));
  while(cache.size && (cache.size>=128 || cacheBytes+bytes>8*1024*1024)) {
    const oldest=cache.keys().next().value!;cacheBytes-=cache.get(oldest)!.bytes;cache.delete(oldest);
  }
  cache.set(key,{value,bytes});cacheBytes+=bytes;return structuredClone(value);
}
