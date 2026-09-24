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
  const { registerRoute, problem } = ctx;

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
  // A package is answered to the caller and not kept. It was kept in this process, keyed by family,
  // so the CDN served a font only until the next restart, and 64 zero bytes as "font/woff2" for
  // every family it had not packaged (architecture programme 1.3, cleanup step).
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
    return c.json(pkg, 200);
  });

  // The stylesheet is derived from the family name alone; its local() sources name fonts the office
  // has installed.
  registerRoute('get', '/fonts/cdn/:fontFamily/style.css', (c: any) => {
    const family = c.req.param('fontFamily');
    const css = generateKurdishFontFaceCss({
      fontFamily: family,
      fontUrl: `/v1/fonts/cdn/${encodeURIComponent(family)}/font.woff2`,
    });

    return c.body(css, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  // No font file is kept, so none is served: the stylesheet's local() sources apply.
  registerRoute('get', '/fonts/cdn/:fontFamily/font.woff2', (c: any) => {
    const family = c.req.param('fontFamily');
    return problem(c, 404, 'Font Not Stored', `No font file is kept for ${family}; the stylesheet falls back to installed fonts.`);
  });
}
