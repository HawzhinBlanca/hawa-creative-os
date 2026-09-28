import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { measureTextGeometry, wrappedLinesOf, renderLayoutV2, fittedTextOf, captureRenderFontInputs } from '../src/studio/render-layout-v2.js';
import { measurePangoText } from '../src/studio/pango-measurement.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const copy='ڕێنمایی (Office 2026) • kaae.gov.krd';
const layout:StudioLayoutV2={version:2,width:1080,height:1350,grid:{margin:76,columns:6,gutter:26,baseline:8},background:{color:'#FFFFFF'},logo:{x:0,y:0,width:1,height:1},shapes:[],text:[{copyIndex:0,role:'title',x:76,y:300,width:300,height:200,fontFamily:'Noto Sans Arabic',fontSize:32,lineHeight:1.35,color:'#000000',align:'right',rtl:true}]};
const white=new PNG({width:1,height:1});white.data.fill(255);
const logoDataUri='data:image/png;base64,'+PNG.sync.write(white).toString('base64');
const fontsDir=path.resolve(import.meta.dirname,'../assets/fonts');
const helper=path.resolve(import.meta.dirname,'../bin/text-measure');
const folders:string[]=[];
afterEach(()=>{for(const dir of folders.splice(0))fs.rmSync(dir,{recursive:true,force:true});});

describe('shared fallback text measurement',()=>{
  it('measures real fallback runs without changing requested family or source copy',()=>{
    const before=JSON.stringify(layout);
    const result=measureTextGeometry(layout,{0:copy})[0];
    expect(result).toMatchObject({status:'measured',method:'pango-wrap-v1',lineCount:2});
    expect(JSON.stringify(layout)).toBe(before);
    expect(wrappedLinesOf(layout.text[0],copy).join(' ')).toBe(copy);
  });

  it.each([
    {rtl:true,fontFamily:'Noto Sans Arabic',text:copy,letterSpacing:0,italic:false},
    {rtl:false,fontFamily:'Noto Sans Arabic',text:copy,letterSpacing:0,italic:false},
    {rtl:false,fontFamily:'Verdana',text:'Office ☎ ✉ ➤ ✔',letterSpacing:0.08,italic:true},
  ])('matches actual librsvg painted bounds for mixed text ($fontFamily, rtl=$rtl)',({rtl,fontFamily,text,letterSpacing,italic})=>{
    const candidate=structuredClone(layout);
    Object.assign(candidate.text[0],{rtl,fontFamily,letterSpacing,italic,bold:true,fontSize:40,x:30,width:1000,height:180});
    const measured=measureTextGeometry(candidate,{0:text})[0];
    expect(measured.status).toBe('measured');
    if(measured.status!=='measured' || !measured.shaping)throw new Error('missing shaping');
    const line=measured.shaping.lines[0];expect(measured.shaping.lines).toHaveLength(1);
    expect(new Set(line.fonts.map(f=>f.sha256)).size).toBeGreaterThan(1);
    const result=renderLayoutV2(candidate,{copyText:{0:text},logoDataUri});
    const baseline=Number(result.svg.match(/<tspan x="[^"]+" y="([^"]+)"/)?.[1]);
    expect(Number.isFinite(baseline)).toBe(true);
    const png=PNG.sync.read(result.png);let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
    for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++){
      const i=(y*png.width+x)*4;
      if(png.data[i]<128 && png.data[i+3]>128){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    }
    const anchor=candidate.text[0].x+candidate.text[0].width;
    expect(Math.abs(left-(anchor-line.width+line.ink.x))).toBeLessThanOrEqual(2);
    expect(Math.abs(right+1-(anchor-line.width+line.ink.x+line.ink.width))).toBeLessThanOrEqual(2);
    expect(Math.abs(top-(baseline+line.ink.y))).toBeLessThanOrEqual(2);
    expect(Math.abs(bottom+1-(baseline+line.ink.y+line.ink.height))).toBeLessThanOrEqual(2);
  });

  it('uses shared fallback wrapping and fitted size for a constrained transfer eyebrow',()=>{
    const t={...layout.text[0],role:'eyebrow' as const,width:360,fontSize:48};
    const fitted=fittedTextOf(t,copy);
    expect(fitted.fontSize).toBeLessThan(t.fontSize);
    const rendered=renderLayoutV2({...layout,text:[t]},{copyText:{0:copy},logoDataUri});
    expect(rendered.svg).toContain(`font-size="${fitted.fontSize}px"`);
    expect((rendered.svg.match(/<tspan /g)||[])).toHaveLength(1);
  });

  it('invalidates actual fallback font bytes and never exposes mutable cached evidence',()=>{
    const dir=fs.mkdtempSync(path.join(tmpdir(),'hawa-fallback-'));folders.push(dir);
    for(const name of ['NotoSansArabic-Regular.ttf','Vazirmatn-Regular.ttf'])fs.copyFileSync(path.join(fontsDir,name),path.join(dir,name));
    const input={text:copy,family:'Noto Sans Arabic',size:32,width:300,spacingPx:0,rtl:true,bold:false,italic:false,fontsDir:dir};
    const first=measurePangoText(input);const hash=first.inputSha256;
    first.lines[0].text='mutated caller';expect(measurePangoText(input).lines[0].text).not.toBe('mutated caller');
    fs.copyFileSync(path.join(fontsDir,'Amiri-Regular.ttf'),path.join(dir,'Vazirmatn-Regular.ttf'));
    expect(measurePangoText(input).inputSha256).not.toBe(hash);
    fs.copyFileSync(path.join(fontsDir,'Vazirmatn-Regular.ttf'),path.join(dir,'Vazirmatn-Regular.ttf'));
    expect(measurePangoText(input).inputSha256).toBe(hash);
  });

  it('binds the helper identity and refuses a missing executable without cached success',()=>{
    const before=captureRenderFontInputs();expect(before.measurement).toHaveProperty('binarySha256');
    const read=fs.readFileSync.bind(fs);
    const unavailable=vi.spyOn(fs,'readFileSync').mockImplementation(((file,...args)=>{
      if(file===helper)throw new Error('ENOENT: injected missing helper');
      return Reflect.apply(read,fs,[file,...args]);
    }) as typeof fs.readFileSync);
    try {
      expect(measureTextGeometry(layout,{0:copy})[0]).toMatchObject({status:'unmeasured',reason:'SHAPING_FAILED'});
      expect(captureRenderFontInputs().sha256).not.toBe(before.sha256);
    } finally {unavailable.mockRestore();}
    expect(captureRenderFontInputs().sha256).toBe(before.sha256);
  });

  it('rejects oversized or malformed protocol inputs and keeps truly absent glyphs refused',()=>{
    const input={text:copy,family:'Noto Sans Arabic',size:32,width:300,spacingPx:0,rtl:true,bold:false,italic:false,fontsDir};
    expect(()=>measurePangoText({...input,text:'x'.repeat(17000)})).toThrow('INPUT_LIMIT');
    expect(()=>measurePangoText({...input,family:'family\nforged'})).toThrow('INVALID_INPUT');
    expect(()=>execFileSync(helper,['32','300','0','1','0','0'],{input:Buffer.from([0xff])})).toThrow();
    expect(measureTextGeometry(layout,{0:'ڕێنمایی \u{10FFFF}'})[0]).toMatchObject({status:'unmeasured',reason:'MISSING_GLYPHS'});
  });

  it('measures spaces between fallback symbols without drawing missing glyphs',()=>{
    const candidate=structuredClone(layout);Object.assign(candidate.text[0],{fontFamily:'Verdana',rtl:false,bold:true,italic:true});
    expect(measureTextGeometry(candidate,{0:'Office ☎ ✉ ➤ ✔'})[0]).toMatchObject({status:'measured',method:'pango-wrap-v1'});
  });
});
