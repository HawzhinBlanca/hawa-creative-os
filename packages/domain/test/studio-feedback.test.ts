import { expect, it } from 'vitest';
import { isRenderedStudioCandidate } from '../src/feedback.js';

it('distinguishes a rendered candidate from an empty or malformed preview claim', () => {
  for (const candidate of [undefined, null, {}, {previewSha256:'pending'}, {hasPreviewBytes:false}]) {
    expect(isRenderedStudioCandidate(candidate)).toBe(false);
  }
  expect(isRenderedStudioCandidate({previewSha256:'a'.repeat(64)})).toBe(true);
  expect(isRenderedStudioCandidate({hasPreviewBytes:true})).toBe(true);
});
