import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_DELIVERABLES, isLateChangeReceiptId, planRequestDeliverables, requestedDeliverableVariant, requestOperatingSubject } from '../src/request-deliverables.js';

describe('explicit request deliverables', () => {
  it('isolates event facts and formats from an explicit two-design request', () => {
    const result=planRequestDeliverables('We need 2 designs for KAAE: a poster for graduation on 12 October at Rotana, and an Instagram story for open day on 20 October at the campus.');
    expect(result.kind).toBe('multiple');
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.count).toBe(2);
    expect(result.shared).toBe('We need 2 designs for KAAE:');
    expect(result.parts[0]).toEqual({text:'a poster for graduation on 12 October at Rotana',variant:undefined});
    expect(result.parts[1]).toEqual({text:'an Instagram story for open day on 20 October at the campus.',variant:{width:1080,height:1920}});
  });
  it('retains common source words in numbered requests', () => {
    const result=planRequestDeliverables('Create 2 designs for KAAE:\nVenue: Erbil hall\n1) Poster for graduation\n2) Story for open day');
    expect(result.kind).toBe('multiple');
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.shared+result.parts.map(p=>p.text).join('\n')).toContain('Venue: Erbil hall');
    expect(result.parts.map(p=>p.variant)).toEqual([undefined,{width:1080,height:1920}]);
  });
  it.each(['Create 3 designs: poster for A and story for B','We need 2 designs: first for graduation, second for open day','Create 2 designs'])('retains ambiguous explicit counts for separate manual allocation: %s', raw=>{
    const result=planRequestDeliverables(raw);
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.parts).toHaveLength(result.count);
    expect(result.parts.every(p=>p.detailsRequired)).toBe(true);
  });
  it.each(['Create 2 designs for KAAE: Poster for graduation on 12 October','We need two versions: Copy:\n2 prizes and 3 winners'])('allows several alternatives of explicitly shared content: %s',raw=>{
    const result=planRequestDeliverables(raw);
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.parts[0].text).toBe(result.parts[1].text);
    expect(result.parts.every(p=>!p.detailsRequired)).toBe(true);
  });
  it.each(['Create a poster with 6 photos','Make a poster for 2 designs exhibition','Text:\nWe need 2 designs for KAAE','Thanks for the two designs','Use all 8 images'])('does not turn factual/photo/count chatter into authorization: %s',raw=>{
    expect(planRequestDeliverables(raw)).toEqual({kind:'single'});
  });
  it('does not split a conjunction or numbered list inside exact copy',()=>{
    const result=planRequestDeliverables('Create 2 versions for KAAE: Copy:\n1) Poster for A\n2) Story for B\nPoster and story are our courses.');
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.parts[0].text).toBe(result.parts[1].text);
    expect(result.parts[0].variant).toBeUndefined();
  });
  it('recognizes two explicit formats of one subject without a numeric count',()=>{
    const result=planRequestDeliverables('Make a poster and an Instagram story for KAAE graduation on 12 October');
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.parts.map(p=>p.text)).toEqual(['a poster for KAAE graduation on 12 October','an Instagram story for KAAE graduation on 12 October']);
  });
  it.each(['Create 9 designs','We need ten posters','Create ٩ designs'])('refuses over-limit requests without trimming: %s',raw=>{
    const result=planRequestDeliverables(raw);
    expect(result.kind).toBe('limit');
    if(result.kind==='limit') expect(result.count).toBeGreaterThan(MAX_REQUEST_DELIVERABLES);
  });
  it('does not infer formats from factual copy',()=>{
    expect(requestedDeliverableVariant('Poster for KAAE\nCopy:\nSize: 5000x4000\nInstagram story')).toBeUndefined();
    expect(requestedDeliverableVariant('Instagram story for KAAE')).toEqual({width:1080,height:1920});
    expect(requestedDeliverableVariant('Size: 1200x1600\nPoster for KAAE')).toEqual({width:1200,height:1600});
  });
  it('names a metadata-first brief from its actual event without replacing an ordinary headline',()=>{
    expect(requestOperatingSubject('Please make a poster for the KAAE accreditation workshop\nDate: 22 November 2026','Date: 22 November 2026')).toBe('KAAE accreditation workshop');
    expect(requestOperatingSubject('Please make a poster for workshop\nOUR OWN TITLE','OUR OWN TITLE')).toBeUndefined();
    expect(requestOperatingSubject('Date: 22 November 2026','Date: 22 November 2026')).toBeUndefined();
    expect(requestOperatingSubject('We need 2 designs for KAAE:\nProduce only this copy.\n_____\na poster for graduation on 12 October','a poster for graduation on 12 October')).toBe('graduation');
  });
  it('recognizes several distinct requested subjects without silently sharing their facts',()=>{
    const result=planRequestDeliverables('Make a poster for graduation on 12 October and a story for open day on 20 October and a banner for workshop on 25 October');
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.count).toBe(3);
    expect(result.parts.every(p=>!p.detailsRequired)).toBe(true);
    expect(result.parts.map(p=>p.text)).toEqual(['a poster for graduation on 12 October','a story for open day on 20 October','a banner for workshop on 25 October']);
  });
  it('recognizes more than two explicit formats of shared content',()=>{
    const result=planRequestDeliverables('Make a poster and a story and a banner for graduation on 12 October');
    if(result.kind!=='multiple') throw new Error('missing deliverables');
    expect(result.count).toBe(3);
    expect(result.parts.map(p=>p.text)).toEqual(['a poster for graduation on 12 October','a story for graduation on 12 October','a banner for graduation on 12 October']);
  });
  it('accepts independently scoped child-note receipts and refuses arbitrary strings',()=>{
    expect(isLateChangeReceiptId('123')).toBe(true);
    expect(isLateChangeReceiptId('123:00000000-0000-4000-8000-000000000011')).toBe(true);
    for(const id of ['0','123:other-task','-1','123:00000000-0000-4000-8000-000000000011:extra',123]) expect(isLateChangeReceiptId(id)).toBe(false);
  });
});
