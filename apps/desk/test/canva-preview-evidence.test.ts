import { describe, expect, it } from 'vitest';
import { canvaPreviewEvidence } from '../src/services/canvaPreviewEvidence.js';

describe('preview check identity', () => {
  const check = {copyPass:true,fontPass:true,rtlPass:true};
  it('never labels a new preview with a passing check from another capture', () => {
    const result = canvaPreviewEvidence([{id:'png',format:'png',capture_version:'200'},
      {id:'pptx',format:'pptx',capture_version:'199',content_check:check}]);
    expect(result.check).toBeUndefined();expect(result.passed).toBe(false);
    expect(result.caption).toContain('no matching');
  });
  it('requires a known matching version and does not use a different-format receipt', () => {
    expect(canvaPreviewEvidence([{id:'png',format:'png'},
      {id:'pptx',format:'pptx',content_check:check}]).passed).toBe(false);
    expect(canvaPreviewEvidence([{id:'png',format:'png',capture_version:'200',content_check:check}]).passed).toBe(false);
  });
  it('uses the latest check for the preview’s version and keeps human review explicit', () => {
    const png={id:'png',format:'png',capture_version:'200'};
    const pptx={id:'pptx',format:'pptx',capture_version:'200',content_check:check};
    expect(canvaPreviewEvidence([png,pptx])).toMatchObject({passed:true,caption:expect.stringContaining('Human visual review')});
    const failed={...pptx,id:'failed',content_check:{...check,rtlPass:false}};
    expect(canvaPreviewEvidence([png,failed,pptx])).toMatchObject({passed:false,caption:expect.stringContaining('blocked')});
  });
});
