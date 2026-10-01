import { describe, expect, it } from 'vitest';
import { freshRoundIntent, nativeRevisionIntent, validReviewedRevisionCopy } from '../src/native-revision.js';

describe('native revision intent',()=>{
  it('reads the immutable direct and wrapped source while preserving malformed intent as a hold',()=>{
    const options={parentTaskId:'parent',revisionDirective:'Change date only'};
    expect(nativeRevisionIntent({studioOptions:options})).toEqual({parentTaskId:'parent',directive:options.revisionDirective});
    expect(nativeRevisionIntent({payload:{studioOptions:options}})).toEqual({parentTaskId:'parent',directive:options.revisionDirective});
    for(const parentTaskId of ['',null,42,{},false])
      expect(nativeRevisionIntent({studioOptions:{parentTaskId}})).toBeDefined();
    for(const source of [null,{}, {studioOptions:{}},{payload:{body:{workflow:'canva_manual'}}}])
      expect(nativeRevisionIntent(source)).toBeUndefined();
  });
  it('ADR-233: a well-formed fresh round is not a native revision; a malformed or ambiguous one is held as one',()=>{
    const parentTaskId='5edca743-0000-4000-8000-000000000001';
    const fresh={parentTaskId,kind:'redo',directive:'do a better design'};
    for(const source of [{studioOptions:{freshFrom:fresh}},{payload:{studioOptions:{revisionRound:2,freshFrom:{...fresh,kind:'pending_changes'}}}}]){
      expect(nativeRevisionIntent(source)).toBeUndefined();
      expect(freshRoundIntent(source)).toMatchObject({parentTaskId});
    }
    for(const freshFrom of [null,[],{...fresh,kind:'native'},{...fresh,directive:' '},{parentTaskId,kind:'redo'},{...fresh,parentTaskId:'x'},{...fresh,extra:1},{...fresh,directive:'x'.repeat(2001)}]){
      expect(nativeRevisionIntent({studioOptions:{freshFrom}})).toEqual({parentTaskId:'__invalid_parent__',directive:''});
      expect(freshRoundIntent({studioOptions:{freshFrom}})).toBeUndefined();
    }
    expect(nativeRevisionIntent({studioOptions:{parentTaskId,freshFrom:fresh}})).toEqual({parentTaskId,directive:''});
    expect(freshRoundIntent({studioOptions:{parentTaskId,freshFrom:fresh}})).toBeUndefined();
  });
  it('preserves exact reviewed copy and rejects unsupported shapes and control bytes',()=>{
    const copy=['  Exact date 2026  ','بەخێربێن'];
    expect(validReviewedRevisionCopy(copy)).toBe(true);expect(copy[0]).toBe('  Exact date 2026  ');
    for(const value of [[],[''],[' '],['a\0b'],[2],['x'.repeat(16001)],new Array(129).fill('x')])
      expect(validReviewedRevisionCopy(value)).toBe(false);
  });
});
