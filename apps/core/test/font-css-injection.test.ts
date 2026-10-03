import { describe, expect, it } from 'vitest';
import { generateKurdishFontFaceCss } from '@hawa/qa';
import { createApp } from '../src/app.js';

/**
 * Bug hunt 3: GET /fonts/cdn/:fontFamily/style.css wrote the family name into CSS (a comment, quoted
 * strings, a class name) and cached the answer for a year. A name holding `*\/` closed the comment
 * and added rules of its own.
 */
const app = createApp({ testAuth: { principal: { role: 'operator' } } });

describe('the font stylesheet route (bug hunt 3)', () => {
  it.each([
    'Evil*/ body{background:red} /*',
    "Quote'); } body { color: red",
    'Back\\slash',
    'New\nline',
    'Angle<style>',
    'x'.repeat(65),
  ])('refuses a family name that could leave the CSS string: %j', async (family) => {
    const res = await app.request(`/v1/fonts/cdn/${encodeURIComponent(family)}/style.css`);
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('immutable');
    expect(await res.text()).not.toContain('background:red');
  });

  it('still serves an ordinary Latin or Kurdish family name', async () => {
    for (const family of ['AsterKurdishTitle', 'Noto Sans Arabic', 'Rabar_022', 'نووسین-Bold.1']) {
      const res = await app.request(`/v1/fonts/cdn/${encodeURIComponent(family)}/style.css`);
      expect(res.status, family).toBe(200);
      expect(await res.text()).toContain(`font-family: '${family}'`);
    }
  });

  it('the generator itself cannot be made to close its comment or string', () => {
    const css = generateKurdishFontFaceCss({ fontFamily: "Evil*/ body{background:red} /* ' \\ \n", fontUrl: "/v1/fonts/cdn/a')x/font.woff2" });
    expect(css.match(/\*\//g)).toHaveLength(2); // the generator's own two comments
    expect(css).not.toContain('background:red}');
    expect(css).not.toMatch(/url\('[^']*'\)x/);
    expect(css.match(/\{/g)).toHaveLength(2);
  });
});
