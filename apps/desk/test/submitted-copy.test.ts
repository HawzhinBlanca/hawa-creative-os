import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { SubmittedCopy } from '../src/components/SubmittedCopy.js';

describe('submitted copy panel', () => {
  it('says no copy was sent when a Kurdish request carried none', () => {
    const html = renderToStaticMarkup(React.createElement(SubmittedCopy, { headlineCkb: '', copyCkb: '' }));
    expect(html).toContain('No copy was sent with this request');
    expect(html).not.toContain('Sorani headline');
    expect(html).not.toContain('Sorani body copy');
  });

  it('shows only the copy the client sent', () => {
    const html = renderToStaticMarkup(React.createElement(SubmittedCopy, { headlineCkb: 'کۆنفرانسی نیشتمانی', copyCkb: null }));
    expect(html).toContain('Sorani headline');
    expect(html).toContain('<div class="copy-value-ckb kurdish-typeset bidi-isolated" dir="rtl" style="white-space:pre-wrap">کۆنفرانسی نیشتمانی</div>');
    expect(html).not.toContain('Sorani body copy');
    expect(html).not.toContain('No copy was sent');
  });
});
