import {
  inspectKurdishFontCoverage,
  KURDISH_SORANI_GLYPH_TABLE,
  packageKurdishWebFont,
  generateKurdishFontFaceCss,
} from '@hawa/qa';
import type { RouteContext } from './types.js';

/**
 * Kurdish web-font inspection and packaging, and the font CDN. Moved out of app.ts by group G1
 * (leaves) of the split (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerFontsRoutes(ctx: RouteContext): void {
  const { registerRoute } = ctx;

  // --- Kurdish WebFont Ingestion & Diacritic Coverage Inspector (B-040, FR-037) ---
  registerRoute('post', '/fonts/inspect', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const fontName = body.fontName || 'Vazirmatn Kurdish';
    let fontSource: any = fontName;

    if (body.characters && Array.isArray(body.characters)) {
      fontSource = body.characters;
    } else if (body.fontBase64) {
      try {
        fontSource = Buffer.from(body.fontBase64, 'base64');
      } catch {
        fontSource = fontName;
      }
    } else {
      // Default to complete Kurdish Sorani character inventory
      fontSource = KURDISH_SORANI_GLYPH_TABLE.map((g) => g.char);
    }

    const result = inspectKurdishFontCoverage(fontSource, fontName);
    return c.json(result, 200);
  });

  // --- Kurdish WebFont Packaging & Asset CDN Delivery (B-040, FR-037) ---
  const packagedFonts = new Map<string, any>();

  registerRoute('post', '/fonts/package', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const fontName = body.fontName || 'Vazirmatn Kurdish';
    let fontBuffer: Uint8Array;

    if (body.fontBase64) {
      try {
        fontBuffer = Buffer.from(body.fontBase64, 'base64');
      } catch {
        fontBuffer = new Uint8Array(128);
      }
    } else {
      fontBuffer = new Uint8Array(128);
    }

    const pkg = packageKurdishWebFont(fontBuffer, fontName);
    packagedFonts.set(pkg.family.toLowerCase(), pkg);

    return c.json(pkg, 200);
  });

  registerRoute('get', '/fonts/cdn/:fontFamily/style.css', (c: any) => {
    const family = c.req.param('fontFamily');
    const cached = packagedFonts.get(family.toLowerCase());
    const css = cached?.cssBundle || generateKurdishFontFaceCss({
      fontFamily: family,
      fontUrl: `/v1/fonts/cdn/${encodeURIComponent(family)}/font.woff2`,
    });

    return c.body(css, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  registerRoute('get', '/fonts/cdn/:fontFamily/font.woff2', (c: any) => {
    const family = c.req.param('fontFamily');
    const cached = packagedFonts.get(family.toLowerCase());
    const bytes = cached?.fontBytes || new Uint8Array(64);

    return c.body(bytes, 200, {
      'Content-Type': 'font/woff2',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
}
