import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureRenderFontInputs, measureMaxLineWidths, loadRenderFontRegistry } from '../src/studio/render-layout-v2.js';
import { pinnedFontconfigFile, symbolFirstFamilies } from '../src/studio/font-environment.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
const dirs: string[]=[];
const assets=resolve(import.meta.dirname,'../assets/fonts');
function folder(){const dir=mkdtempSync(join(tmpdir(),'hawa-font-basis-'));dirs.push(dir);return dir;}
function populated(){const dir=folder();copyFileSync(join(assets,'NotoSansArabic-Regular.ttf'),join(dir,'NotoSansArabic-Regular.ttf'));return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const layout={text:[{copyIndex:0,fontFamily:'Noto Sans Arabic',fontSize:48,lineHeight:1.6,width:2000,height:100,x:0,y:0,role:'title',color:'#000000',align:'right',rtl:true}]} as StudioLayoutV2;
const copy={0:'ڕێنمایی زانکۆی کوردستان'};

describe('retained font basis',()=>{
  it('replaces a cached same-path font instead of reusing stale measurements',()=>{
    const dir=populated(), file=join(dir,'NotoSansArabic-Regular.ttf');
    const before=measureMaxLineWidths(layout,copy,{fontsDir:dir})[0];
    const stamp=statSync(file);
    copyFileSync(join(assets,'Amiri-Regular.ttf'),file);
    utimesSync(file,stamp.atime,stamp.mtime);
    const after=measureMaxLineWidths(layout,copy,{fontsDir:dir})[0];
    const independent=populated();copyFileSync(join(assets,'Amiri-Regular.ttf'),join(independent,'NotoSansArabic-Regular.ttf'));
    expect(after).not.toBe(before);
    expect(after).toBe(measureMaxLineWidths(layout,copy,{fontsDir:independent})[0]);
    unlinkSync(file);
    expect(measureMaxLineWidths(layout,copy,{fontsDir:dir})[0]).toBeUndefined();
    copyFileSync(join(assets,'NotoSansArabic-Regular.ttf'),file);
    expect(measureMaxLineWidths(layout,copy,{fontsDir:dir})[0]).toBe(before);
  });
  it('hashes bytes and inventory, remains stable across copies and detects replacement/deletion',()=>{
    const a=populated(),b=populated();
    const read=(fontsDir:string)=>captureRenderFontInputs({fontsDir,systemFiles:[]});
    const initial=read(a);expect(read(b)).toEqual(initial);
    copyFileSync(join(assets,'Amiri-Regular.ttf'),join(a,'NotoSansArabic-Regular.ttf'));
    expect(read(a).sha256).not.toBe(initial.sha256);
    copyFileSync(join(assets,'NotoSansArabic-Regular.ttf'),join(a,'NotoSansArabic-Regular.ttf'));
    expect(read(a)).toEqual(initial);
    unlinkSync(join(a,'NotoSansArabic-Regular.ttf'));expect(read(a).sha256).not.toBe(initial.sha256);
    expect(()=>read(join(a,'absent'))).toThrow();
  });
  it('refreshes registry content under the same path and identifies changed policy',()=>{
    const dir=populated(),registryPath=join(dir,'registry.json');
    const original=readFileSync(resolve(import.meta.dirname,'../src/studio/render-fonts.json'),'utf8');
    writeFileSync(registryPath,original);
    const first=captureRenderFontInputs({fontsDir:dir,registryPath,systemFiles:[]});
    const registry=loadRenderFontRegistry({registryPath});
    const changed={...registry,version:registry.version+1};writeFileSync(registryPath,JSON.stringify(changed));
    expect(loadRenderFontRegistry({registryPath}).version).toBe(changed.version);
    expect(captureRenderFontInputs({fontsDir:dir,registryPath,systemFiles:[]}).sha256).not.toBe(first.sha256);
  });
  it('regenerates fontconfig and family discovery after font contents change',()=>{
    const dir=populated();const initial=pinnedFontconfigFile(dir,[]);
    copyFileSync(join(assets,'Inter-Regular.ttf'),join(dir,'NotoSansArabic-Regular.ttf'));
    expect(symbolFirstFamilies(dir,[])).toContain('Inter');
    expect(pinnedFontconfigFile(dir,[])).not.toBe(initial);
    expect(pinnedFontconfigFile(dir,[])).toBe(pinnedFontconfigFile(dir,[]));
  });
});
