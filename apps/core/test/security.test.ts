import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Core API: Security Invariants & Asset Ingestion', () => {
  const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

  it('enforces OWASP secure headers on all responses', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-XSS-Protection')).toBe('1; mode=block');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('ingests and verifies valid PNG image asset', async () => {
    const res = await app.request('/v1/assets/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'campaign_logo.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        clientId: 'client-security-spec',
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.assetId).toBeDefined();
    expect(json.sha256).toBeDefined();
    expect(json.mimeType).toBe('image/png');
    expect(json.storageKey).toContain('assets/');
  });

  it('sanitizes SVG asset containing malicious script tags and inline event handlers', async () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>document.location='http://evil.com'</script>
      <circle cx="25" cy="25" r="20" fill="red" />
    </svg>`;

    const res = await app.request('/v1/assets/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'icon_warning.svg',
        mimeType: 'image/svg+xml',
        clientId: 'client-security-spec',
        sizeBytes: Buffer.byteLength(maliciousSvg),
        content: maliciousSvg,
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.sanitized).toBe(true);
    expect(json.sanitizedContent).not.toContain('<script');
    expect(json.sanitizedContent).not.toContain('onload=');
    expect(json.sanitizedContent).toContain('<circle cx="25" cy="25" r="20" fill="red" />');
  });

  it('rejects forbidden file types (e.g. .exe, .sh, .html) with RFC 7807 problem response', async () => {
    const res = await app.request('/v1/assets/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'malware.sh',
        mimeType: 'application/x-sh',
        sizeBytes: 50,
      }),
    });

    expect(res.status).toBe(400);
    const problem = await res.json();
    expect(problem.type).toBe('https://hawa.design/errors/400');
    expect(problem.title).toBe('Asset Security Policy Violation');
    expect(problem.detail).toContain('prohibited');
  });

  it('provides standalone SVG sanitization endpoint for HyCanvas design studio', async () => {
    const svgWithXxe = `<?xml version="1.0"?>
    <!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/shadow"> ]>
    <svg xmlns="http://www.w3.org/2000/svg">
      <text>&xxe;</text>
    </svg>`;

    const res = await app.request('/v1/assets/sanitize-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg: svgWithXxe }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.violations.some((v: string) => v.includes('XXE'))).toBe(true);
    expect(json.sanitized).not.toContain('<!DOCTYPE');
    expect(json.sanitized).not.toContain('<!ENTITY');
  });
});
