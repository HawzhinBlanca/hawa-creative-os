import { describe, it, expect } from 'vitest';
import { buildKaaeInvitationOperations, parseInvitationContent } from '../src/templates/kaae-invitation.template.js';
import { renderOperationsToSvg } from '../src/operations-to-svg.js';
import { checkNodeCollisions } from '../../qa/src/layout-bounds.js';

describe('FR-027/038 invitation regression controls', () => {
  it('contains the actual asset, no blank logo placeholder or unapproved protocol footer', () => {
    const ops = buildKaaeInvitationOperations();
    const svg = renderOperationsToSvg(ops);
    expect(svg).toContain('xlink:href="data:image/png;base64,');
    expect(svg).not.toContain('PROTOCOL OFFICE');
    expect(svg).not.toContain('DATE &amp; TIME');
  });
  it('places every text block within the canvas without text collisions', () => {
    const text = buildKaaeInvitationOperations().filter(op => op.op === 'addText');
    for (const op of text) { expect(op.y + op.height).toBeLessThan(1350 - 28); expect(op.x + op.width).toBeLessThan(1080); }
    const collisions = checkNodeCollisions(text.map(op => ({ id: op.nodeId, x: op.x, y: op.y, width: op.width, height: op.height, role: op.role, text: op.text })));
    expect(collisions).toEqual([]);
  });
  it('rejects oversized copy instead of overlapping or silently dropping it', () => {
    expect(() => buildKaaeInvitationOperations({ extraParagraphs: ['Additional supplied copy. '.repeat(300)] })).toThrow('exceeds safe canvas');
  });
  it('a similarly named unknown client logo never becomes KAAE or a placeholder', () => {
    expect(() => renderOperationsToSvg([{ op: 'addImage', nodeId: 'another_client_logo', pageId: 'p', asset: { storageKey: 'assets/kaae.png', sha256: 'a'.repeat(64), mimeType: 'image/png' }, x: 0, y: 0, width: 100, height: 100, fit: 'contain' }])).toThrow('asset bytes unavailable');
  });
  it('preserves both repeated Prime Minister paragraphs', () => {
    const content = 'Invitation\n\nThe Prime Minister will speak.\n\nThe Prime Minister will close the occasion.';
    const parsed = parseInvitationContent(content);
    expect(parsed.keynoteBody).toBe('The Prime Minister will speak.');
    expect(parsed.extraParagraphs).toContain('The Prime Minister will close the occasion.');
  });
});
