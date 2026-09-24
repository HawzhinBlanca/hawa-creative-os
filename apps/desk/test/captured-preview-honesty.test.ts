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
    const html = renderToStaticMarkup(React.createElement(VectorInspector, { previewUrl: 'data:image/png;base64,iVBORw0KGgo=', title: 'Recorded export', dimensions: { width: 400, height: 300 } }));
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('400 × 300');
    expect(html).not.toMatch(/Layer Tree|SVG XML|Download|AUTHENTIC/);
  });
  it('a signed-in Core address is fetched first (authorized-image.test.ts), so it starts as loading, not as a bare <img>', () => {
    const html = renderToStaticMarkup(React.createElement(VectorInspector, { previewUrl: '/v1/tasks/t/exports/e/content', title: 'Recorded export', dimensions: { width: 400, height: 300 } }));
    expect(html).not.toContain('<img');
    expect(html).toContain('Loading preview');
    expect(html).toContain('400 × 300');
  });
});
