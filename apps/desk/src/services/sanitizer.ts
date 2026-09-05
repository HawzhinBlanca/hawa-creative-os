/**
 * Browser-safe high-assurance SVG and vector markup sanitizer (HD-004).
 * Neutralizes XSS vectors, inline event handlers, script elements,
 * forbidden HTML tags (like <img>, <iframe>, <foreignObject>), and dangerous URL schemes.
 */
export function sanitizeSvgContent(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw;

  // 1. Strip XML DOCTYPE and ENTITY declarations (XXE defense)
  cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/gi, '');
  cleaned = cleaned.replace(/<!ENTITY[^>]*>/gi, '');

  // 2. Strip executable <script> tags and their contents
  cleaned = cleaned.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '');
  cleaned = cleaned.replace(/<script\b[^>]*\/?>/gi, '');

  // 3. Strip dangerous embedding and non-SVG tags
  const dangerousTags = [
    'script', 'foreignobject', 'object', 'embed', 'iframe',
    'applet', 'meta', 'link', 'audio', 'video', 'base',
    'form', 'input', 'button', 'select', 'textarea', 'img'
  ];
  for (const tag of dangerousTags) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // 4. Strip ANY inline event handlers (on* attributes like onload, onerror, onclick, onpointerdown, etc.)
  cleaned = cleaned.replace(/\s+(on[a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, '');

  // 5. Neutralize dangerous URL schemes in href, xlink:href, src, action
  cleaned = cleaned.replace(/(href|xlink:href|src|action)\s*=\s*["']?\s*(javascript:|vbscript:|data:text\/html)/gi, '$1="#blocked"');

  // 6. Neutralize CSS expressions or javascript in inline style attributes
  cleaned = cleaned.replace(/style\s*=\s*("[^"]*expression\s*\([^"]*"|'[^']*expression\s*\([^']*')/gi, 'style=""');
  cleaned = cleaned.replace(/style\s*=\s*("[^"]*javascript:[^"]*"|'[^']*javascript:[^']*')/gi, 'style=""');

  return cleaned.trim();
}
