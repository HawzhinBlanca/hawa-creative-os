import { describe, expect, it, vi } from 'vitest';
import { buildP3Prompt } from '../src/services/design-studio/prompts.js';
import { runLayoutsStage } from '../src/services/design-studio/stages/layouts.stage.js';
import type { StageContext, CreativeBrief, Concept } from '../src/services/design-studio/types.js';

describe('standard customer composition retains server constraints', () => {
  it('advertises the actual story top and bottom bounds to the model', () => {
    const prompt = buildP3Prompt({conceptId:'story',creativeBriefJson:'{}',conceptJson:'{}',width:1080,height:1920,
      marginPx:96,bodyMinPx:18,logoMinPx:100,logoAspect:1,palette:'#FAFAFA,#214365',latinFont:'Inter',arabicFont:'Amiri',copyBlocks:'[0] TITLE'});
    expect(prompt).toContain('y ≥ 269');expect(prompt).toContain('y + h ≤ 1536');
  });
  it('sends all six admitted photos and their coverage constraint through the actual standard layout stage', async () => {
    const completeJson = vi.fn(async () => ({data:{layout:{version:2,width:1080,height:1920,
      grid:{margin:96,columns:6,gutter:24,baseline:8},background:{color:'#FAFAFA'},shapes:[],
      logo:{x:96,y:269,width:100,height:100},text:[{copyIndex:0,role:'title',x:96,y:500,width:888,height:144,
        fontFamily:'Inter',fontSize:72,lineHeight:1.3,color:'#214365',align:'left'}],
      photos:Array.from({length:6},(_,i)=>({photoIndex:i,role:'content',x:96+(i%3)*270,y:700+Math.floor(i/3)*300,width:240,height:240,radius:0}))}}}));
    const ctx={width:1080,height:1920,copyBlocks:[{text:'TITLE',script:'latin'}],latinFont:'Inter',arabicFont:'Amiri',
      referencePack:{palette:['#FAFAFA','#214365']},client:{completeJson},logoAspect:1,
      photos:Array.from({length:6},()=>({width:1024,height:1024,notes:''})),photoSelection:{mode:'all',minimum:6,insisted:true}} as unknown as StageContext;
    await runLayoutsStage(ctx,{roles:[],must:[],mustNot:[]} as unknown as CreativeBrief,[{id:'story'}] as Concept[]);
    const prompt=(completeJson.mock.calls[0] as unknown as [{prompt:string}])[0].prompt;
    expect(prompt).toContain('Client photographs to place (6)');
    expect(prompt).toContain('5: 1024x1024');
    expect(prompt).toContain('Each appears exactly once');
  });
});
