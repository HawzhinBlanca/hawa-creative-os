import { afterEach, describe, expect, it, vi } from 'vitest';

// A browser has no node:crypto; this makes the dynamic import fail the way it does there.
vi.mock('node:crypto', () => {
  throw new Error('node:crypto is not available in a browser');
});

import { computeDocumentHash } from '../src/services/draftStorage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('draft integrity hash', () => {
  it('refuses to stamp a draft when SHA-256 is unavailable instead of labelling a weaker checksum sha256_', async () => {
    vi.stubGlobal('crypto', undefined);
    await expect(computeDocumentHash('{"nodes":[]}')).rejects.toThrow('SHA-256 is unavailable in this browser context');
  });
});
