import { describe, it, expect } from 'vitest';
import { renderOperationsToSvg } from '../src/operations-to-svg.js';

// The KAAE invitation template these controls exercised is retired (ADR-127); KAAE's invitations are
// made in the design studio. What is left guards the renderer itself.
describe('FR-027/038 renderer regression controls', () => {
  it('a similarly named unknown client logo never becomes KAAE or a placeholder', () => {
    expect(() => renderOperationsToSvg([{ op: 'addImage', nodeId: 'another_client_logo', pageId: 'p', asset: { storageKey: 'assets/kaae.png', sha256: 'a'.repeat(64), mimeType: 'image/png' }, x: 0, y: 0, width: 100, height: 100, fit: 'contain' }])).toThrow('asset bytes unavailable');
  });
});
