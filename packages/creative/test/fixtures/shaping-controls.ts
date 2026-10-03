/**
 * ADR-290 negative controls: a Studio render's SVG with one block's lines drawn wrong on purpose, the
 * way a broken renderer or provider would draw them. Each control edits only that block's `<text>`
 * element, so the rest of the poster (and the text-free render) is unchanged.
 */
export type ShapingControl = 'unjoined' | 'one-join-broken' | 'reversed' | 'substituted-face' | 'rewrapped' | 'missing-glyph';

const ZWNJ = '‌';
/** Letters that never join the letter after them (right-joining in Sorani and Arabic). */
const RIGHT_JOINING = new Set(Array.from('ءآأؤإادذرزژوۆەڕۊۋ'));
const ARABIC_LETTER = /[ؠ-يٮ-ۓەۺ-ۿ]/;
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

interface Tspan { attrs: string; text: string }

function readText(svg: string, id: string): { start: number; end: number; open: string; tspans: Tspan[] } {
  const match = new RegExp(`(<text id="${id}"[^>]*>)([\\s\\S]*?)</text>`).exec(svg);
  if (!match) throw new Error(`No text element ${id}`);
  const tspans = [...match[2].matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)].map((m) => ({ attrs: m[1], text: unescapeXml(m[2]).replace(/[‫‬]/g, '') }));
  return { start: match.index, end: match.index + match[0].length, open: match[1], tspans };
}

function writeText(svg: string, id: string, rtl: boolean, edit: (t: ReturnType<typeof readText>) => { open: string; tspans: Tspan[] }): string {
  const t = readText(svg, id);
  const { open, tspans } = edit(t);
  const body = tspans.map((s) => `<tspan${s.attrs}>${rtl && s.text ? `‫${escapeXml(s.text)}‬` : escapeXml(s.text)}</tspan>`).join('');
  return svg.slice(0, t.start) + open + body + '</text>' + svg.slice(t.end);
}

/** Where one ZWNJ breaks a join that is drawn: between two letters, the first of which joins forward. */
export function breakOneJoin(line: string): string | undefined {
  const chars = Array.from(line);
  const middle = Math.floor(chars.length / 2);
  const order = chars.map((_, i) => i).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
  for (const i of order) {
    if (i < 1) continue;
    const before = chars[i - 1], after = chars[i];
    if (ARABIC_LETTER.test(before) && ARABIC_LETTER.test(after) && !RIGHT_JOINING.has(before)) return [...chars.slice(0, i), ZWNJ, ...chars.slice(i)].join('');
  }
  return undefined;
}

/**
 * The SVG with `control` applied to block `id`'s first line (its whole layout for `rewrapped`).
 * `substitute` is the family a substituted face is drawn in. Undefined when the control cannot apply
 * (no join to break; one word to re-wrap).
 */
export function applyShapingControl(svg: string, id: string, rtl: boolean, control: ShapingControl, opts: { substitute?: string; pitchPx?: number } = {}): string | undefined {
  const t = readText(svg, id);
  const first = t.tspans[0]?.text ?? '';
  const replaceFirst = (text: string) => writeText(svg, id, rtl, (x) => ({ open: x.open, tspans: [{ ...x.tspans[0], text }, ...x.tspans.slice(1)] }));
  switch (control) {
    case 'unjoined': return replaceFirst(Array.from(first).join(ZWNJ));
    case 'one-join-broken': { const broken = breakOneJoin(first); return broken ? replaceFirst(broken) : undefined; }
    case 'reversed': return replaceFirst(Array.from(first).reverse().join(''));
    case 'missing-glyph': { const words = first.split(' '); words.splice(Math.ceil(words.length / 2), 0, '\\u0D9A\\u0D9B'); return replaceFirst(words.join(' ')); }
    case 'substituted-face': {
      if (!opts.substitute) return undefined;
      return writeText(svg, id, rtl, (x) => ({ open: x.open.replace(/font-family="[^"]*"/, `font-family="${opts.substitute}"`), tspans: x.tspans }));
    }
    case 'rewrapped': {
      if (t.tspans.length >= 2) {
        const words = first.split(' ');
        if (words.length < 2) return undefined;
        const moved = words.pop()!;
        return writeText(svg, id, rtl, (x) => ({ open: x.open, tspans: [{ ...x.tspans[0], text: words.join(' ') }, { ...x.tspans[1], text: `${moved} ${x.tspans[1].text}` }, ...x.tspans.slice(2)] }));
      }
      const words = first.split(' ');
      if (words.length < 2 || !opts.pitchPx) return undefined;
      const cut = Math.ceil(words.length / 2);
      const y = Number(/ y="([\d.]+)"/.exec(t.tspans[0].attrs)?.[1]);
      const up = (yy: number) => t.tspans[0].attrs.replace(/ y="[\d.]+"/, ` y="${yy.toFixed(1)}"`);
      return writeText(svg, id, rtl, (x) => ({ open: x.open, tspans: [
        { attrs: up(y - opts.pitchPx! / 2), text: words.slice(0, cut).join(' ') },
        { attrs: up(y + opts.pitchPx! / 2), text: words.slice(cut).join(' ') },
      ] }));
    }
  }
}
