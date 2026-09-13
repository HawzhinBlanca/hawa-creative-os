import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { VectorInspector } from '../src/components/VectorInspector.js';

describe('captured evidence preview', () => {
  it('never manufactures a design or verification from brief text', () => {
    const html = renderToStaticMarkup(React.createElement(VectorInspector, { title: 'Test brief', exactCopy: { headlineEn: 'A brief is not an artifact' } }));
    expect(html).toContain('No captured design yet');
    expect(html).not.toContain('A brief is not an artifact');
    expect(html).not.toMatch(/AUTHENTIC|OFFICIAL SEAL|Layer Tree|Download|1080/);
    expect(html).not.toContain('<img');
  });
  it('renders the supplied preview without inventing native layer or export controls', () => {
    const html = renderToStaticMarkup(React.createElement(VectorInspector, { previewUrl: '/evidence/capture.png', title: 'Recorded export', dimensions: { width: 400, height: 300 } }));
    expect(html).toContain('src="/evidence/capture.png"');
    expect(html).toContain('400 × 300');
    expect(html).not.toMatch(/Layer Tree|SVG XML|Download|AUTHENTIC/);
  });
});
