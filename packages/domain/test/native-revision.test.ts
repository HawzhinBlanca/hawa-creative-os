import { describe, expect, it } from 'vitest';
import { nativeRevisionIntent, validReviewedRevisionCopy } from '../src/native-revision.js';

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
  it('preserves exact reviewed copy and rejects unsupported shapes and control bytes',()=>{
    const copy=['  Exact date 2026  ','بەخێربێن'];
    expect(validReviewedRevisionCopy(copy)).toBe(true);expect(copy[0]).toBe('  Exact date 2026  ');
    for(const value of [[],[''],[' '],['a\0b'],[2],['x'.repeat(16001)],new Array(129).fill('x')])
      expect(validReviewedRevisionCopy(value)).toBe(false);
  });
});
