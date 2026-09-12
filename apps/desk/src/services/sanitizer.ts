import DOMPurify from 'dompurify';

/**
 * Browser-safe high-assurance SVG and vector markup sanitizer (HD-004, Phase 3).
 * Neutralizes XSS vectors, inline event handlers, script elements,
 * forbidden embedding tags (<foreignObject>, <iframe>, <object>, etc.), and dangerous URL schemes.
 * Uses DOMPurify with a strict SVG profile as primary defense, backed by defense-in-depth sanitization.
 */
export function sanitizeSvgContent(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw;

  // 1. Strip XML DOCTYPE and ENTITY declarations (XXE defense)
  cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/gi, '');
  cleaned = cleaned.replace(/<!ENTITY[^>]*>/gi, '');

  // 2. DOMPurify sanitization (when running in DOM-capable environments)
  if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
    try {
      cleaned = DOMPurify.sanitize(cleaned, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['use', 'style'],
        FORBID_TAGS: [
          'script',
          'foreignobject',
          'foreignObject',
          'iframe',
          'object',
          'embed',
          'applet',
          'meta',
          'link',
          'base',
          'form',
          'input',
          'button',
          'select',
          'textarea',
          'img',
          'video',
          'audio',
        ],
        FORBID_ATTR: [
          'onerror',
          'onload',
          'onclick',
          'onmouseover',
          'onpointerdown',
          'onfocus',
          'onblur',
          'onchange',
        ],
        ALLOW_DATA_ATTR: false,
      }) as string;
    } catch {
      // If DOMPurify throws in non-DOM/mock environments, continue to regex fallback below
    }
  }

  // 3. Strip executable <script> tags and their contents
  cleaned = cleaned.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '');
  cleaned = cleaned.replace(/<script\b[^>]*\/?>/gi, '');

  // 4. Strip dangerous embedding and non-SVG tags
  const dangerousTags = [
    'script', 'foreignobject', 'object', 'embed', 'iframe',
    'applet', 'meta', 'link', 'audio', 'video', 'base',
    'form', 'input', 'button', 'select', 'textarea', 'img'
  ];
  for (const tag of dangerousTags) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // 5. Strip ANY inline event handlers (on* attributes)
  cleaned = cleaned.replace(/\s+(on[a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, '');

  // 6. Neutralize dangerous URL schemes in href, xlink:href, src, action
  cleaned = cleaned.replace(/(href|xlink:href|src|action)\s*=\s*["']?\s*(javascript:|vbscript:|data:text\/html)/gi, '$1="#blocked"');

  // 7. Neutralize CSS expressions or javascript in inline style attributes
  cleaned = cleaned.replace(/style\s*=\s*("[^"]*expression\s*\([^"]*"|'[^']*expression\s*\([^']*')/gi, 'style=""');
  cleaned = cleaned.replace(/style\s*=\s*("[^"]*javascript:[^"]*"|'[^']*javascript:[^']*')/gi, 'style=""');

  return cleaned.trim();
}

