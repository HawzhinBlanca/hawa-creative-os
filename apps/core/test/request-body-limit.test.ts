import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CORE_MAX_BODY_BYTES } from '../src/body-limit.js';
import { ASSET_JSON_MAX_BYTES } from '../src/services/uploaded-asset-input.js';
import { CUSTOMER_PHOTO_MAX_BYTES } from '../src/customer/customer-photos.js';
import { DOCUMENT_MAX_BYTES } from '@hawa/retrieval';
import { MAX_IMAGE_BYTES } from '../src/services/comparison-study.js';

/**
 * Bug hunt 3: Core read request bodies of any size. A global limit, above the largest legitimate
 * upload, answers 413 with a problem body before a handler reads the rest.
 */
const app = createApp({ testAuth: { principal: { role: 'operator' } } });

function chunked(bytes: number, chunk = 1024 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const n = Math.min(chunk, bytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x20));
    },
  });
}

describe('the request body limit (bug hunt 3)', () => {
  it('sits above every legitimate upload Core accepts', () => {
    // Two comparison images as base64 in one JSON body are the largest legitimate request.
    const comparison = 2 * Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;
    for (const legit of [ASSET_JSON_MAX_BYTES, CUSTOMER_PHOTO_MAX_BYTES, DOCUMENT_MAX_BYTES, comparison]) {
      expect(CORE_MAX_BODY_BYTES).toBeGreaterThan(legit);
    }
  });

  it('refuses a declared oversize body with a 413 problem before any handler', async () => {
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(CORE_MAX_BODY_BYTES + 1) },
      body: chunked(16),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, title: 'Payload Too Large', type: 'https://hawa.design/errors/413' });
  });

  it('refuses an undeclared (chunked) body once it passes the limit', async () => {
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: chunked(CORE_MAX_BODY_BYTES + 1024 * 1024),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, title: 'Payload Too Large' });
  });

  it('passes a body under the limit through to the route, chunked or declared', async () => {
    const body = JSON.stringify({ title: 'Under the limit', clientId: 'client-drustee', padding: ' '.repeat(2 * 1024 * 1024) });
    const declared = await app.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(declared.status).not.toBe(413);
    const streamed = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Blob([body]).stream(),
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).not.toBe(413);
    expect(streamed.status).toBe(declared.status);
  });
});
