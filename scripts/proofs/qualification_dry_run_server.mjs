/**
 * A local stand-in for the model API, for a qualification dry run: the runner's whole flow —
 * generation, preparation, ranking, critique, refinement, judge, canary, ledger and report — runs
 * against it before any money is spent. Every runner defect found this month surfaced only on a
 * paid run; this is where they are meant to surface instead.
 *
 * It answers each structured call by its schema name:
 *   layout_v3_candidates     three well-formed candidates built from the brief's own copy slots,
 *                            canvas and palette, read out of the prompt
 *   DesignCritiqueReport     an assessment with no comments, so refinement stops after one critique
 *   layout_v3_repair         the layout it was sent, unchanged
 *   PairwiseDimensionVerdict a judge with a consistent, arbitrary preference (by image hash), so
 *                            the same design wins from either position
 *
 *   node scripts/proofs/qualification_dry_run_server.mjs [port] [--credits <calls answered before refusing>]
 *   HAWA_QUALIFICATION_DRY_RUN_URL=http://127.0.0.1:<port> HAWA_SPEND_STATE_DIR=<tmp> \
 *     HAWA_QUALIFICATION_OUT_DIR=<tmp> npx tsx scripts/run_p10_qualification.ts
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.argv[2] || 18765);
// --credits <n>: answer the first n calls, then refuse every later one as an account out of credits
// does, so a runner's handling of that failure can be exercised without spending anything.
const creditsAt = process.argv.indexOf('--credits');
const CREDITS = creditsAt > 0 ? Number(process.argv[creditsAt + 1]) : Infinity;
const DIMENSIONS = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'];

function candidatesFor(prompt) {
  const dims = /Target Dimensions: (\d+)px x (\d+)px/.exec(prompt);
  const W = Number(dims?.[1] || 1080);
  const H = Number(dims?.[2] || 1350);
  const palette = (/Primary Palette: ([^\n]+)/.exec(prompt)?.[1] || '#0A1628, #F7B500, #FDF8F3').split(',').map((c) => c.trim());
  const blocks = [...prompt.matchAll(/- Block (\d+) \[role: "([^"]+)", script: "([^"]+)"\]/g)].map((m) => ({
    index: Number(m[1]),
    role: m[2],
    script: m[3],
  }));
  const rtl = blocks.some((b) => b.script === 'arabic');
  const gold = palette.find((c) => /F7B500/i.test(c)) || palette[1] || '#F7B500';
  const ink = palette.find((c) => /FDF8F3|FFFFFF/i.test(c)) || '#FFFFFF';
  const panel = palette.find((c) => /1E3A5F/i.test(c)) || palette[1] || '#1E3A5F';

  const mx = 0.08;
  const my = (mx * W) / H;
  const logoPx = Math.round(0.14 * Math.min(W, H));
  const px = (v) => v / H;
  const sizeFor = (role) =>
    role === 'title' ? Math.max(40, Math.round(0.05 * Math.min(W, H)))
    : role === 'subtitle' ? 26
    : role === 'body' ? Math.max(18, Math.ceil(0.016 * W))
    : 16;
  const heightFor = (role) => (role === 'title' ? 0.13 : role === 'subtitle' ? 0.07 : role === 'body' ? 0.16 : 0.05);
  const fontFor = (role, script) =>
    script === 'arabic'
      ? role === 'body' || role === 'footer' ? 'Noto Sans Arabic' : 'Amiri'
      : role === 'body' || role === 'footer' ? 'Verdana' : role === 'title' ? 'Cinzel' : 'Playfair Display';

  const build = (id, archetype, align, logoX, withPanel) => {
    const usableTop = my + px(logoPx) + 0.06;
    const total = blocks.reduce((a, b) => a + heightFor(b.role), 0);
    const gap = Math.max(0.01, (1 - my - usableTop - total) / Math.max(1, blocks.length));
    let y = usableTop;
    const width = align === 'center' ? 1 - 2 * mx : 0.7 - mx;
    const x = align === 'center' ? mx : rtl ? 1 - mx - width : mx;
    const text = blocks.map((b) => {
      const h = heightFor(b.role);
      const t = {
        copyIndex: b.index, role: b.role, x, y, width, height: h,
        fontSize: px(sizeFor(b.role)), lineHeight: 1.3, letterSpacing: null,
        fontFamily: fontFor(b.role, b.script), color: b.role === 'title' ? gold : ink,
        align: align === 'center' ? 'center' : rtl ? 'right' : 'left',
        bold: b.role === 'title', italic: false, rtl: b.script === 'arabic',
      };
      y += h + gap;
      return t;
    });
    const body = text.find((t) => t.role === 'body');
    const shapes = withPanel && body
      ? [{ x: mx, y: body.y - 0.01, width: 1 - 2 * mx, height: body.height + 0.02, kind: 'rect', color: panel, opacity: 1, radius: null, strokeWidth: null, strokeColor: null, role: 'panel' }]
      : [];
    return {
      id, conceptTitle: archetype.replace(/_/g, ' '), compositionArchetype: archetype,
      typeScale: { base: 16, ratio: 1.333 },
      grid: { margin: mx, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: palette[0] || '#0A1628' },
      logo: { x: logoX, y: my, width: logoPx / W, height: logoPx / H },
      art: null, shapes, text,
    };
  };
  const centreX = 0.5 - logoPx / W / 2;
  const sideX = rtl ? 1 - mx - logoPx / W : mx;
  return [
    build('dry-1', 'monolith_centered', 'center', centreX, false),
    build('dry-2', 'asymmetric_editorial', 'side', sideX, false),
    build('dry-3', 'hero_statement_grid', 'center', centreX, true),
  ];
}

function answer(body) {
  const schema = body.response_format?.json_schema?.name;
  const messages = body.messages || [];
  const promptText = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const userContent = messages[1]?.content;
  const images = Array.isArray(userContent) ? userContent.filter((c) => c.type === 'image_url').map((c) => c.image_url.url) : [];
  if (schema === 'layout_v3_candidates') return { layouts: candidatesFor(promptText) };
  if (schema === 'DesignCritiqueReport') return { overallAssessment: 'Dry run: no comments.', comments: [] };
  if (schema === 'layout_v3_repair') {
    const json = /```json\n([\s\S]*?)\n```/.exec(promptText)?.[1];
    return { repairSummary: 'Dry run: unchanged.', layout: json ? JSON.parse(json) : {} };
  }
  if (schema === 'PairwiseDimensionVerdict') {
    const hash = (s) => createHash('sha256').update(s || '').digest('hex');
    const winner = hash(images[0]) < hash(images[1]) ? 'A' : 'B';
    return {
      dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { winner, rationale: 'Dry run preference.' }])),
      majorityWinner: winner,
      summary: `Dry run prefers ${winner}.`,
    };
  }
  throw new Error(`dry-run server has no answer for schema '${schema}'`);
}

let calls = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (calls >= CREDITS) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'You have no credits remaining. Add credits to continue using the API.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }));
      return;
    }
    try {
      const body = JSON.parse(raw);
      const data = answer(body);
      const content = JSON.stringify(data);
      calls++;
      res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': `req_dryrun_${calls}` });
      res.end(JSON.stringify({
        id: `chatcmpl-dryrun-${String(calls).padStart(6, '0')}`,
        model: body.model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(content.length / 4), prompt_tokens_details: { cached_tokens: 0 } },
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`dry-run model API listening on http://127.0.0.1:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
