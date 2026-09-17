/**
 * Re-runs the P05 vision critique inside the production image, where every bundled font renders
 * exactly, and compares each verdict against the one the T5 run produced on the dev host.
 *
 * Why: the critique is fed a Set-of-Mark annotated render, and on the macOS dev host rsvg-convert
 * silently substitutes Helvetica for Cinzel, Playfair Display and Cairo. Every T5 critique therefore
 * judged text placement using the wrong faces' metrics. The layouts are reused as-is, so this pays
 * for one vision call per brief instead of regenerating layouts.
 *
 * Usage (from the repo root):
 *   docker run --rm \
 *     -v "$PWD/packages/creative/dist:/app/packages/creative/dist:ro" \
 *     -v "$PWD/output:/work/output" \
 *     -v "$PWD/scripts/proofs:/work/scripts:ro" \
 *     -e OPENAI_API_KEY="..." \
 *     hawa-core:<tag> node /work/scripts/rerun_p05_critique.mjs <briefsDir> <outDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { generateBoxGroundedCritique } = await import(
  '/app/packages/creative/dist/studio/box-critique-v3.js'
);
const { getFontFidelityManifest } = await import(
  '/app/packages/creative/dist/studio/render-layout-v2.js'
);

const briefsDir = process.argv[2];
const outDir = process.argv[3];
if (!briefsDir || !outDir) {
  console.error('usage: rerun_p05_critique.mjs <briefsDir> <outDir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// Fail before spending if this host would substitute a face the layouts use.
const fidelity = getFontFidelityManifest('/app/packages/creative/assets/fonts');
console.log('font fidelity measured here:');
for (const [k, v] of Object.entries(fidelity)) console.log(`  ${k.padEnd(20)}${v}`);

const IN_RATE = 10 / 1e6;
const OUT_RATE = 50 / 1e6;
const CACHED_RATE = 1 / 1e6;

// Optional --only=brief_03,brief_11 restricts the run to named brief folders, so a fix that
// changed only some renders can be re-critiqued without paying for the rest again.
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').filter(Boolean)) : null;

const jobs = [];
for (const name of fs.readdirSync(briefsDir).sort()) {
  const folder = path.join(briefsDir, name);
  const layoutPath = path.join(folder, 'layout.json');
  const briefPath = path.join(folder, 'brief.json');
  if (!fs.existsSync(layoutPath) || !fs.existsSync(briefPath)) continue;
  if (only && !only.has(name)) continue;
  jobs.push({ name, folder, layoutPath, briefPath });
}
if (only) console.log(`--only restricted this run to ${jobs.length} of ${only.size} named briefs`);

const standInBlockers = [];
for (const job of jobs) {
  const layout = JSON.parse(fs.readFileSync(job.layoutPath, 'utf8'));
  for (const family of new Set((layout.text || []).map((t) => t.fontFamily).filter(Boolean))) {
    if (fidelity[family] === 'stand-in') standInBlockers.push(`${job.name}:${family}`);
  }
}
if (standInBlockers.length) {
  console.error(
    `refusing to spend: these layouts use a substituted face here — ${standInBlockers.join(', ')}`
  );
  process.exit(3);
}
console.log(`\n${jobs.length} briefs to re-critique; every family they use renders exactly here.\n`);

async function runOne(job) {
  const layout = JSON.parse(fs.readFileSync(job.layoutPath, 'utf8'));
  const brief = JSON.parse(fs.readFileSync(job.briefPath, 'utf8'));
  const copyText = Object.fromEntries((brief.copyBlocks || []).map((b) => [b.copyIndex, b.text]));

  const result = await generateBoxGroundedCritique(layout, {
    model: 'gpt-6-astra',
    renderOptions: { copyText },
  });

  const r = result.receipt;
  const cached = r.cachedTokens ?? 0;
  const gross = r.inputTokens * IN_RATE + r.outputTokens * OUT_RATE;
  const discount = cached * (IN_RATE - CACHED_RATE);

  // The verdict this brief got before, for comparison.
  let before = null;
  const priorPath = path.join(job.folder, 'critique.json');
  if (fs.existsSync(priorPath)) {
    const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
    before = {
      status: prior.status,
      commentCount: (prior.comments || []).length,
      categories: (prior.comments || []).map((c) => c.category).sort(),
      severities: (prior.comments || []).map((c) => c.severity).sort(),
      overallAssessment: prior.overallAssessment,
      responseId: prior.receipt?.responseId,
    };
  }

  fs.writeFileSync(
    path.join(outDir, `${brief.id}.annotated.png`),
    result.annotatedPng
  );

  const entry = {
    brief: brief.id,
    folder: job.name,
    size: `${layout.width}x${layout.height}`,
    familiesUsed: [...new Set((layout.text || []).map((t) => t.fontFamily).filter(Boolean))],
    after: {
      status: result.status,
      commentCount: result.comments.length,
      categories: result.comments.map((c) => c.category).sort(),
      severities: result.comments.map((c) => c.severity).sort(),
      overallAssessment: result.overallAssessment,
      comments: result.comments,
      rejectedCount: result.rejectedComments.length,
      compositeScore: result.deterministicMetrics?.compositeScore,
    },
    before,
    annotatedSha256: createHash('sha256').update(result.annotatedPng).digest('hex'),
    ledger: {
      call_id: r.responseId,
      x_request_id: r.xRequestId || '',
      stage: 'P05_CRITIQUE_RERUN',
      brief_id: brief.id,
      model: r.model,
      input_tokens: r.inputTokens,
      cached_tokens: cached,
      output_tokens: r.outputTokens,
      gross_cost_usd: gross,
      cache_discount_usd: discount,
      net_cost_usd: gross - discount,
      latency_ms: r.latencyMs,
    },
  };
  console.log(
    `${brief.id.padEnd(26)} comments ${before ? before.commentCount : '?'} -> ${result.comments.length}` +
      `  $${(gross - discount).toFixed(6)}  ${r.latencyMs}ms  ${r.responseId}`
  );
  return entry;
}

const entries = [];
const failures = [];
const concurrencyArg = process.argv.find((a) => a.startsWith('--concurrency='));
const CONCURRENCY = concurrencyArg
  ? Math.max(1, parseInt(concurrencyArg.slice('--concurrency='.length), 10) || 2)
  : 2;
for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  const batch = jobs.slice(i, i + CONCURRENCY);
  const settled = await Promise.allSettled(batch.map(runOne));
  for (let k = 0; k < settled.length; k++) {
    if (settled[k].status === 'rejected') {
      const reason =
        settled[k].reason instanceof Error ? settled[k].reason.message : String(settled[k].reason);
      console.error(`FAILED ${batch[k].name}: ${reason}`);
      failures.push({ folder: batch[k].name, reason });
    } else {
      entries.push(settled[k].value);
    }
  }
  fs.writeFileSync(
    path.join(outDir, 'P05_RECRITIQUE.json'),
    JSON.stringify({ fontFidelity: fidelity, entries, failures }, null, 2)
  );
}

const header =
  'call_id,x_request_id,stage,brief_id,model,input_tokens,cached_tokens,output_tokens,gross_cost_usd,cache_discount_usd,net_cost_usd,latency_ms\n';
fs.writeFileSync(
  path.join(outDir, 'P05_RECRITIQUE_LEDGER.csv'),
  header +
    entries
      .map((e) => {
        const l = e.ledger;
        return [
          l.call_id,
          l.x_request_id,
          l.stage,
          l.brief_id,
          l.model,
          l.input_tokens,
          l.cached_tokens,
          l.output_tokens,
          l.gross_cost_usd.toFixed(6),
          l.cache_discount_usd.toFixed(6),
          l.net_cost_usd.toFixed(6),
          l.latency_ms,
        ].join(',');
      })
      .join('\n')
);

const total = entries.reduce((a, e) => a + e.ledger.net_cost_usd, 0);
const changed = entries.filter(
  (e) => e.before && e.before.commentCount !== e.after.commentCount
);
console.log(
  `\n${entries.length} re-critiqued, ${failures.length} failed, total $${total.toFixed(6)}`
);
console.log(
  `verdicts whose comment count changed once the typography was correct: ${changed.length}/${entries.length}`
);
