import { describe, expect, it } from 'vitest';
import { canRetryCanvaCreation } from '../src/canva-creation.js';

describe('Canva creation retry evidence', () => {
  it('requires positive evidence rather than a failed label', () => {
    expect(canRetryCanvaCreation({status:'failed'})).toBe(false);
    expect(canRetryCanvaCreation({status:'failed',metadata:{failureEvidence:{kind:'not_accepted'}}})).toBe(true);
  });
  it('requires the exact failed job and refuses contradictory returned design evidence', () => {
    const operation={status:'failed',remote_job_id:'job-a',metadata:{failureEvidence:{kind:'provider_failed' as const,remoteJobId:'job-a'}}};
    expect(canRetryCanvaCreation(operation)).toBe(true);
    expect(canRetryCanvaCreation({...operation,remote_job_id:'job-b'})).toBe(false);
    expect(canRetryCanvaCreation({...operation,design_id:'DA_existing'})).toBe(false);
    expect(canRetryCanvaCreation({...operation,metadata:{failureEvidence:{kind:'not_accepted'}}})).toBe(false);
  });
  it.each(['creating','submitted','uncertain','retrieved'])('never clears %s based on failure metadata', status => {
    expect(canRetryCanvaCreation({status,metadata:{failureEvidence:{kind:'not_accepted'}}})).toBe(false);
  });
});
