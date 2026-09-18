/**
 * Quantifies how much the design metrics prefer a full-width centred composition over an
 * equally-gridded asymmetric one holding the same copy.
 *
 * Why this exists: 16 of 20 winners in the production qualification were monolith_centered, and the
 * cause is here rather than in the generator (which offers three distinct archetypes with pairwise
 * distances of 123-423px) or the judge (which correctly discards order-flipped pairs). It is
 * computeNegativeSpace counting each text BOX as occupied area: a block spanning four columns is
 * scored as emptier than the same copy spanning six, even though the ink is the same or greater.
 *
 * Both layouts below are deliberately on-grid — every block spans a whole number of columns — so
 * the comparison isolates composition from sloppiness. An earlier version of this test gave the
 * asymmetric layout arbitrary widths and wrongly blamed gridAppropriateness, which scores 1.000 for
 * both once the widths are column-exact.
 *
 * Run: node scripts/proofs/measure_composition_bias.mjs
 */
const metrics = await import('../../packages/creative/dist/studio/design-metrics.js');
const render = await import('../../packages/creative/dist/studio/render-layout-v2.js');

const W = 1080;
const H = 1350;
const MARGIN = 76;
const COLS = 6;
const GUT = 26;
const colW = (W - 2 * MARGIN - (COLS - 1) * GUT) / COLS;
const span = (n) => Math.round(n * colW + (n - 1) * GUT);

const COPY = {
  0: 'Kurdistan Accrediting Agency for Education',
  1: 'Mandatory Quality Standards 2026',
  2: 'Institutional Excellence Under Law No. 6',
  3: 'All universities must publish audited accreditation reports by the end of Q3.',
  4: 'Erbil • September 2026 • kaae.gov.krd',
};

const base = (over) => ({
  version: 2, width: W, height: H, genre: 'poster',
  grid: { margin: MARGIN, columns: COLS, gutter: GUT, baseline: 14 },
  background: { color: '#0A1628' },
  logo: { x: Math.round(W / 2 - 100), y: 90, width: 200, height: 120 },
  shapes: [], text: [], ...over,
});
const T = (o) => ({
  copyIndex: o.i, role: o.role, x: o.x, y: o.y, width: o.w, height: o.h,
  fontSize: o.size, lineHeight: 1.35, fontFamily: o.font || 'Verdana',
  color: '#FDF8F3', align: o.align, bold: !!o.bold, italic: false, rtl: false,
});

const centred = base({
  text: [
    T({ i: 0, role: 'eyebrow', x: MARGIN, y: 260, w: span(6), h: 40, size: 18, align: 'center', font: 'Cinzel' }),
    T({ i: 1, role: 'title', x: MARGIN, y: 360, w: span(6), h: 180, size: 54, align: 'center', font: 'Playfair Display', bold: true }),
    T({ i: 2, role: 'subtitle', x: MARGIN, y: 580, w: span(6), h: 70, size: 26, align: 'center', font: 'Playfair Display' }),
    T({ i: 3, role: 'body', x: MARGIN, y: 760, w: span(6), h: 200, size: 22, align: 'center' }),
    T({ i: 4, role: 'footer', x: MARGIN, y: 1180, w: span(6), h: 44, size: 16, align: 'center' }),
  ],
  shapes: [
    { x: Math.round(W / 2 - 80), y: 320, width: 160, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    { x: MARGIN, y: 730, width: span(6), height: 260, kind: 'rect', color: '#162B48', role: 'panel' },
  ],
});

const asymmetric = base({
  logo: { x: MARGIN, y: 90, width: 200, height: 120 },
  text: [
    T({ i: 0, role: 'eyebrow', x: MARGIN, y: 260, w: span(4), h: 40, size: 18, align: 'left', font: 'Cinzel' }),
    T({ i: 1, role: 'title', x: MARGIN, y: 360, w: span(5), h: 180, size: 54, align: 'left', font: 'Playfair Display', bold: true }),
    T({ i: 2, role: 'subtitle', x: MARGIN, y: 580, w: span(4), h: 70, size: 26, align: 'left', font: 'Playfair Display' }),
    T({ i: 3, role: 'body', x: MARGIN, y: 760, w: span(4), h: 200, size: 22, align: 'left' }),
    T({ i: 4, role: 'footer', x: MARGIN, y: 1180, w: span(4), h: 44, size: 16, align: 'left' }),
  ],
  shapes: [
    { x: MARGIN, y: 320, width: span(1), height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    { x: MARGIN, y: 730, width: span(4), height: 260, kind: 'rect', color: '#162B48', role: 'panel' },
  ],
});

const cases = [['centred full-width', centred], ['asymmetric, column-exact', asymmetric]];
const out = cases.map(([name, layout]) => {
  const wrappedLines = render.measureWrappedLines(layout, COPY);
  return {
    name,
    box: metrics.evaluateDesignMetrics(layout),
    ink: metrics.evaluateDesignMetrics(layout, { wrappedLines }),
    lines: layout.text.map((t) => wrappedLines[t.copyIndex] ?? 1),
  };
});

console.log('Both layouts hold identical copy and every block spans a whole number of columns.\n');
console.log('metric'.padEnd(22) + cases.map(([n]) => n.padEnd(26)).join('') + 'favours');
for (const k of Object.keys(out[0].box.metrics)) {
  const a = out[0].box.metrics[k].score;
  const b = out[1].box.metrics[k].score;
  const fav = Math.abs(a - b) < 0.005 ? '-' : a > b ? 'CENTRED' : 'asymmetric';
  console.log(k.padEnd(22) + a.toFixed(3).padEnd(26) + b.toFixed(3).padEnd(26) + fav);
}

const gapBox = out[0].box.compositeScore - out[1].box.compositeScore;
const gapInk = out[0].ink.compositeScore - out[1].ink.compositeScore;
console.log('\nwrapped lines per block: ' + out.map((o) => `${o.name} ${JSON.stringify(o.lines)}`).join('  |  '));
console.log('\ncomposite, box measure (shipping):  ' +
  out.map((o) => o.box.compositeScore.toFixed(3)).join('  vs  ') + `   gap ${gapBox.toFixed(4)}`);
console.log('composite, ink measure (unwired):  ' +
  out.map((o) => o.ink.compositeScore.toFixed(3)).join('  vs  ') + `   gap ${gapInk.toFixed(4)}`);
console.log(
  `\nThe shipping measure gives the centred layout a ${gapBox.toFixed(3)} advantage for no reason a ` +
    `reader could see.\nThe ink measure reduces that to ${gapInk.toFixed(3)}, but lowers both scores ` +
    `below the current band, so the\nband has to move with it. Any recalibration should be checked ` +
    `against this gap: it is the number\nthat has to reach roughly zero for the pipeline to stop ` +
    `preferring one composition.`
);
