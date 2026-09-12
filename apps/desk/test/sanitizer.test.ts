import { describe, it, expect } from 'vitest';
import { sanitizeSvgContent } from '../src/services/sanitizer.js';

describe('Desk DOMPurify SVG Sanitizer (Phase 3 & HD-004)', () => {
  it('strips script tags and executable JavaScript', () => {
    const malicious = '<svg><script>alert("xss")</script><rect width="100" height="100"/></svg>';
    const cleaned = sanitizeSvgContent(malicious);
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('alert');
    expect(cleaned).toContain('<rect');
  });

  it('strips inline event handlers (onload, onerror, onclick, onpointerdown)', () => {
    const malicious = '<svg onload="alert(1)" onclick="steal()"><circle cx="50" cy="50" r="40" onerror="eval(1)"/></svg>';
    const cleaned = sanitizeSvgContent(malicious);
    expect(cleaned).not.toContain('onload');
    expect(cleaned).not.toContain('onclick');
    expect(cleaned).not.toContain('onerror');
    expect(cleaned).toContain('<circle');
  });

  it('strips foreignObject and embedding elements (iframe, object, embed)', () => {
    const malicious = '<svg><foreignObject width="100" height="100"><iframe src="https://evil.com"></iframe></foreignObject><text>Safe</text></svg>';
    const cleaned = sanitizeSvgContent(malicious);
    expect(cleaned).not.toContain('foreignObject');
    expect(cleaned).not.toContain('foreignobject');
    expect(cleaned).not.toContain('iframe');
    expect(cleaned).toContain('<text>Safe</text>');
  });

  it('neutralizes malicious javascript: and data: URIs in href and xlink:href', () => {
    const malicious = '<svg><a href="javascript:alert(1)"><text>Click</text></a><image xlink:href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="/></svg>';
    const cleaned = sanitizeSvgContent(malicious);
    expect(cleaned).not.toContain('javascript:');
    expect(cleaned).not.toContain('data:text/html');
  });

  it('preserves legitimate Kurdish Sorani text and valid SVG vector shapes', () => {
    const valid = '<svg viewBox="0 0 100 100"><rect fill="#160874" width="100" height="100"/><text x="10" y="20" fill="#E8B85C">سڵاو لە هەولێر</text></svg>';
    const cleaned = sanitizeSvgContent(valid);
    expect(cleaned).toContain('سڵاو لە هەولێر');
    expect(cleaned).toContain('rect');
    expect(cleaned).toContain('viewBox');
  });

  it('gracefully handles null, undefined, or empty payloads', () => {
    expect(sanitizeSvgContent(null)).toBe('');
    expect(sanitizeSvgContent(undefined)).toBe('');
    expect(sanitizeSvgContent('')).toBe('');
  });
});
