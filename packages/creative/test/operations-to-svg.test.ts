import { describe, it, expect } from 'vitest';
import { escapeXml, renderOperationsToSvg } from '../src/operations-to-svg.js';

describe('operations-to-svg escaping', () => {
  it('escapes any value, including numbers and undefined, instead of throwing', () => {
    expect(escapeXml(700)).toBe('700');
    expect(escapeXml(undefined)).toBe('');
    expect(escapeXml(null)).toBe('');
    expect(escapeXml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&apos;');
  });

  it('renders a text operation whose style carries a numeric font weight and letter spacing', () => {
    // Regression: a numeric fontWeight made escapeXml throw, the Telegram bridge caught it, and the
    // requester received a text-only fallback instead of the revised preview.
    const svg = renderOperationsToSvg(
      [
        {
          op: 'addText', nodeId: 'headline', pageId: 'p1', role: 'headline',
          text: 'Accreditation <2026> & beyond',
          x: 40, y: 40, width: 1000, height: 400,
          style: { fontSize: 48, fontWeight: 700, letterSpacing: 2, color: '#111111', fontFamily: 'Inter' },
        },
      ] as any,
      1080,
      1350,
    );
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('letter-spacing="2"');
    expect(svg).toContain('Accreditation &lt;2026&gt; &amp; beyond');
  });
});
