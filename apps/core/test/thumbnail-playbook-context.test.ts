import { describe, it, expect } from 'vitest';
import { hardQaContextFor, clientRenderAssetsFor } from '../src/services/design-studio/stages/v3.stage.js';

/** ADR-038: the stage context carries the client's playbook to hard QA, and its logo to the judge. */
const base = {
  width: 1280,
  height: 720,
  copyBlocks: [{ text: 'Why cities flood', script: 'latin' as const }],
  latinFont: 'Inter',
  arabicFont: 'Noto Sans Arabic',
  referencePack: { palette: ['#101820', '#FFFFFF'] } as any,
  logoAspect: 1,
  photos: [],
};

describe('the stage context of a thumbnail client', () => {
  it('hands its playbook to hard QA, and none for a client without one', () => {
    expect(hardQaContextFor({ ...base, playbook: 'video-thumbnail' }).playbook).toBe('video-thumbnail');
    expect(hardQaContextFor(base)).not.toHaveProperty('playbook');
  });

  it("hands the judge's renders the client's own logo and photos", () => {
    const logo = { bytes: Buffer.from('logo-bytes'), sha256: 'x', mimeType: 'image/png' as const };
    const photo = { bytes: Buffer.from('photo'), mimeType: 'image/jpeg' };
    const assets = clientRenderAssetsFor({ logo, photos: [photo] as any });
    expect(assets.logoDataUri).toBe(`data:image/png;base64,${Buffer.from('logo-bytes').toString('base64')}`);
    expect(assets.photoFiles).toEqual([{ bytes: photo.bytes, mediaType: 'image/jpeg' }]);
    expect(clientRenderAssetsFor({})).toEqual({});
  });
});
