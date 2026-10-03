import { describe, expect, it } from 'vitest';
import { normalizeStudioLayout } from '../src/studio/studio-normalize.js';
import { getSafeZoneBox } from '../src/studio/house-rules.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { customerPhotoSelection } from '../src/studio/photo-selection.js';

function proposal(height = 1920) {
  return { version: 2, width: 1080, height,
    grid: { margin: 96, columns: 6, gutter: 24, baseline: 8 },
    background: { color: '#FAFAFA' }, shapes: [], photos: [],
    logo: { x: 490, y: 96, width: 100, height: 100 },
    text: [{ copyIndex: 0, role: 'title', x: 96, y: height - 240, width: 888, height: 144,
      fontFamily: 'Inter', fontSize: 72, lineHeight: 1.3, color: '#214365', align: 'left' }] };
}
describe('normalization uses the same story bounds as hard validation', () => {
  it('lets website automatic photo use choose one or several and preserves explicit all/count words', () => {
    expect(customerPhotoSelection({photoCount:6,usage:{mode:'auto'}},'Compose for this content.',6)).toMatchObject({mode:'choose',minimum:1});
    expect(customerPhotoSelection({photoCount:6,usage:{mode:'auto'}},'Use all photos.',6)).toMatchObject({mode:'all',minimum:6,insisted:true});
    expect(customerPhotoSelection({photoCount:6,usage:{mode:'count',count:3}},'Use all photos.',6)).toMatchObject({mode:'choose',minimum:3,maximum:3});
  });
  it('keeps a model-proposed logo and footer-sized title inside the story safe rectangle', () => {
    const layout = normalizeStudioLayout(proposal(),1080,1920,1);
    const safe = getSafeZoneBox(1080,1920,96);
    expect(layout.logo.y).toBe(safe.y);
    expect(layout.text[0].y + layout.text[0].height).toBe(safe.y + safe.height);
    expect(validateLayoutV2(layout,{expectedWidth:1080,expectedHeight:1920,copyCount:1,photoCount:0,
      copyScripts:['latin'],reference:{rules:{fontFamily:'Inter',palette:['#FAFAFA','#214365']},logoAspect:1},draftFont:'Inter'}).ok).toBe(true);
  });
  it('places a missing logo inside the story safe rectangle instead of manufacturing an invalid layout', () => {
    const {logo: _logo,...raw} = proposal();
    expect(normalizeStudioLayout(raw,1080,1920).logo.y).toBe(getSafeZoneBox(1080,1920,96).y);
  });
  it('preserves non-story margin placement and refuses to shrink oversized content', () => {
    expect(normalizeStudioLayout(proposal(1350),1080,1350).logo.y).toBe(96);
    const raw = proposal();raw.text[0].height = 1800;
    const layout = normalizeStudioLayout(raw,1080,1920);
    expect(layout.text[0].height).toBe(1800);
    expect(validateLayoutV2(layout,{expectedWidth:1080,expectedHeight:1920,copyCount:1,photoCount:0,
      copyScripts:['latin'],reference:{rules:{fontFamily:'Inter',palette:['#FAFAFA','#214365']},logoAspect:1},draftFont:'Inter'}).ok).toBe(false);
  });
});
