import { describe, expect, it } from 'vitest';
import { describeFetchCause } from '../src/studio/openai-studio-client.js';

/** Node's fetch says "fetch failed" for every network fault and hides the reason in err.cause. */
describe('describeFetchCause', () => {
  it('names the code and message behind "fetch failed"', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    expect(describeFetchCause(err)).toBe('UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error');
    const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(describeFetchCause(reset)).toBe('ECONNRESET: read ECONNRESET');
  });
  it('is empty when there is no cause', () => {
    expect(describeFetchCause(new Error('x'))).toBe('');
    expect(describeFetchCause(undefined)).toBe('');
  });
});
