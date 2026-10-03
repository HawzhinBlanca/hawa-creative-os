/**
 * The grammar composers' outputs, case by case, for proving a performance change output-preserving.
 *
 *   tsx scripts/poster_composer_snapshot.ts write <file.json>   # on the base commit
 *   tsx scripts/poster_composer_snapshot.ts check <file.json>   # on the change: exits 1 on any difference
 *
 * Every case composes one poster (navy, cream, band) or one guideline page/cover with KAAE's admitted
 * grammar and records the whole layout as JSON (or the infeasibility message), with its time. The cases
 * are the ADR-262 proof briefs, the poster and guideline test fixtures, the orchestrator's infeasible
 * long title (test 5b), long Sorani titles, and the wide canvases (1920x1080, 1080x1920).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { composeGrammarLayout, pageGrammarFromRaw, type ComposeGrammarInput } from '../packages/creative/src/studio/page-grammar.js';
import { composePosterLayout, POSTER_VARIANTS } from '../packages/creative/src/studio/poster-grammar.js';

const RAW = JSON.parse(readFileSync(new URL('../packages/creative/assets/kaae-reference.json', import.meta.url), 'utf8'));
const G = pageGrammarFromRaw(RAW)!;

type Brief = { id: string; lines: string[]; roles: string[] };
const LONG_TITLE = 'EXACT TITLE OF A VERY LONG ANNOUNCEMENT THAT RUNS ON AND ON '.repeat(4).trim();
const BRIEFS: Brief[] = [
  // ADR-262 proof briefs (output/design-retarget/briefs.ts).
  { id: 'proof_en_workshop', lines: ['Quality Assurance Workshop', 'For university deans', '15 October 2026 · 9:30 AM', 'Rotana Hotel, Erbil', 'Registration is free'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'proof_en_peer_call', lines: ['Call for Peer Evaluators', 'K-12 and Higher Education'], roles: ['title', 'subtitle'] },
  { id: 'proof_en_symposium', lines: ['KAAE Annual Accreditation Symposium 2026', '4 November 2026', 'Erbil International Fair'], roles: ['title', 'date', 'venue'] },
  { id: 'proof_ckb_workshop', lines: ['وۆرکشۆپی دڵنیایی جۆری', 'بۆ ڕاگرانی زانکۆکان', '١٥ی تشرینی یەکەمی ٢٠٢٦، ٩:٣٠ی بەیانی', 'هوتێل ڕۆتانا، هەولێر', 'تۆمارکردن بەخۆڕاییە'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'proof_ckb_peer_call', lines: ['بانگەواز بۆ هەڵسەنگێنەرانی هاوتا', 'پەروەردەی بنەڕەتی و خوێندنی باڵا'], roles: ['title', 'subtitle'] },
  // kaae-poster-compositions.test.ts (the Sorani workshop without the time).
  { id: 'test_ckb_workshop', lines: ['وۆرکشۆپی دڵنیایی جۆری', 'بۆ ڕاگرانی زانکۆکان', '١٥ی تشرینی یەکەمی ٢٠٢٦', 'هوتێل ڕۆتانا، هەولێر', 'تۆمارکردن بەخۆڕاییە'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  // kaae-2025-guideline.test.ts.
  { id: 'guide_workshop', lines: ['Quality Assurance Workshop', 'For school principals', '22 October 2026 · 10:00 AM', 'Divan Hotel, Erbil', 'Seats are limited, please register early'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'guide_cover', lines: ['Accreditation Cycle 2027', 'Applications now open', 'From 1 November 2026', 'kaae.org'], roles: ['title', 'subtitle', 'date', 'footer'] },
  // design-studio-orchestrator.test.ts 5b: a title no poster can carry.
  { id: 'orchestrator_5b_long_title', lines: [LONG_TITLE, 'Exact body text line. Never rewrite it.'], roles: ['title', 'body'] },
  // Long Sorani titles: the band under a long title, and one too long for any poster.
  { id: 'ckb_long_title_band', lines: ['وۆرکشۆپی نیشتمانی دڵنیایی جۆری و متمانەپێدانی پەروەردەی باڵا لە هەرێمی کوردستان', 'بۆ ڕاگرانی زانکۆکان', '١٥ی تشرینی یەکەمی ٢٠٢٦', 'هوتێل ڕۆتانا، هەولێر', 'تۆمارکردن بەخۆڕاییە'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'ckb_too_long_title', lines: ['وۆرکشۆپی نیشتمانی دڵنیایی جۆری و متمانەپێدانی پەروەردەی باڵا لە هەرێمی کوردستان '.repeat(3).trim(), 'تۆمارکردن بەخۆڕاییە'], roles: ['title', 'body'] },
];
const CANVASES: Array<[number, number]> = [[1080, 1350], [1920, 1080], [1080, 1920]];

type Case = { id: string; run: () => unknown };
function cases(): Case[] {
  const out: Case[] = [];
  for (const b of BRIEFS) {
    for (const [width, height] of CANVASES) {
      const base: ComposeGrammarInput = {
        width, height, grammar: G, copy: { text: Object.fromEntries(b.lines.map((t, i) => [i, t])) }, roles: Object.fromEntries(b.roles.map((r, i) => [i, r])),
        logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone: 'page', fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' },
      };
      for (const variant of POSTER_VARIANTS) out.push({ id: `${b.id}@${width}x${height}/poster/${variant}`, run: () => composePosterLayout({ ...base, variant }) });
      for (const variant of ['brand_card', 'cards']) out.push({ id: `${b.id}@${width}x${height}/page/${variant}`, run: () => composeGrammarLayout({ ...base, tone: 'page', variant }) });
      for (const variant of ['pattern', 'sunburst']) out.push({ id: `${b.id}@${width}x${height}/cover/${variant}`, run: () => composeGrammarLayout({ ...base, tone: 'cover', variant }) });
    }
  }
  return out;
}

const [mode, file, filter] = process.argv.slice(2);
if ((mode !== 'write' && mode !== 'check') || !file) {
  console.error('usage: tsx scripts/poster_composer_snapshot.ts write|check <file.json> [id-substring]');
  process.exit(2);
}
const results: Record<string, { output: string; ms: number }> = {};
let total = 0;
for (const c of cases()) {
  if (filter && !c.id.includes(filter)) continue;
  const t0 = performance.now();
  let output: string;
  try {
    output = JSON.stringify(c.run());
  } catch (err) {
    output = `THROWS ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
  const ms = performance.now() - t0;
  total += ms;
  results[c.id] = { output, ms: Math.round(ms) };
  console.log(`${String(Math.round(ms)).padStart(6)} ms  ${c.id}${output.startsWith('THROWS') ? '  (infeasible)' : ''}`);
}
console.log(`${Math.round(total)} ms total, ${Object.keys(results).length} cases`);
if (mode === 'write') {
  writeFileSync(file, JSON.stringify(results, null, 1));
} else {
  const before = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { output: string; ms: number }>;
  let diff = 0;
  let beforeMs = 0;
  for (const [id, r] of Object.entries(results)) {
    const b = before[id];
    if (!b) { console.log(`MISSING in snapshot: ${id}`); diff++; continue; }
    beforeMs += b.ms;
    if (b.output !== r.output) { console.log(`DIFFERS: ${id}`); diff++; }
  }
  console.log(`${Object.keys(results).length - diff}/${Object.keys(results).length} identical; snapshot ${beforeMs} ms -> now ${Math.round(total)} ms`);
  if (diff) process.exit(1);
}
