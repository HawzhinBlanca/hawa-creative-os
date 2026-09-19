#!/usr/bin/env node
/**
 * Re-prepares every stored design of one or more qualification runs with the current preparation
 * and reports production's hard QA and the design metrics, before and after. No model calls.
 *
 * The regression gate for any change to preparation (`prepareGeneratedLayoutV3`): run it over every
 * stored run before paying for a new one. On 2026-09-18 it found every mechanical QA failure left in
 * 140 stored designs, each of which became a regression test.
 *
 *   pnpm gate:prepare          # builds, globs every stored run, compares against gate-baseline.json
 *   pnpm gate:prepare:update   # the same, re-recording the baseline
 *
 * Both glob `output/proofs/*` rather than naming runs. A hand-picked list left out cheap run 2
 * through `b8c84f6`, which hid its two designs with text set on the logo (2026-09-18).
 *
 * It runs every design through each option set production calls preparation with, not just the bare
 * canvas. Until 2026-09-20 the gate passed only `{width, height, logoAspect, palette}` while
 * `apps/core/src/services/design-studio/stages/layouts.stage.ts` also passes `ornament`
 * (`resolveOrnamentSettings`) and `style` (the StyleSpec the brief reads off the client's
 * reference). That blind spot hid a quarter of the corpus: applying the owner's real spec from task
 * 89c242f2 to the 200 stored designs drops hard-QA passes from 195/200 to 143/200 (51 OVERLAP,
 * 14 COPY_ORDER, 4 COPY_OVERFLOW, 2 LOGO) and the gate still exited 0.
 *
 * Exits 1 when a design is worse than `gate-baseline.json` records for its mode: a new hard-QA
 * defect code, a newly failing design metric, or preparation newly making a shippable design worse
 * (passed QA before preparation, fails after). Improvements are reported, never failed. Pass
 * `--update-baseline` to re-record the file after a deliberate improvement, and say in the commit
 * message which numbers moved and why.
 *
 * The corpus lives in `output/proofs/2026-09-18-*` and is gitignored (`output/proofs/**\/briefs/`),
 * so a checkout without it cannot run this gate at all. `packages/creative/test/gate-modes.test.ts`
 * is the CI foothold: it runs committed fixture designs through these same modes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const BASELINE_PATH = path.join(HERE, 'gate-baseline.json');
export const FIXTURES_DIR = path.join(ROOT, 'packages/creative/test/fixtures');

/**
 * Every style reference committed as a fixture, as `{name, spec}`. One file per client reference the
 * brief has actually read (`reference-<name>.json`, the `.spec` field). Adding one adds a gate mode,
 * which the baseline will not know yet: that is deliberate, so a new reference cannot enter the
 * pipeline ungated.
 */
export function readStyleFixtures(dir = FIXTURES_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('reference-') && f.endsWith('.json'))
    .sort()
    .map((f) => {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).spec;
      if (!spec) throw new Error(`${f}: a reference fixture must carry the brief's .spec`);
      return { name: f.slice('reference-'.length, -'.json'.length), spec };
    });
}

/**
 * The option sets production calls `prepareGeneratedLayoutV3` with, as the layouts stage builds
 * them. `background` is per request (the brand colour a client names) and no stored brief records
 * one, so no mode can cover it; see the report in the commit that added these modes.
 *
 * Ornament is resolved from an empty environment rather than `process.env` on purpose: production
 * reads the owner's variables, but a baseline that moved with whatever `HAWA_DESIGN_TEXTURE` the
 * operator's shell happened to export would not be a baseline. The empty environment gives the
 * documented defaults (sun-rays at 0.25, dividers on, balance on). A style mode carries ornament
 * too, because production never passes a style without one, and `ornamentForStyle` lets the spec
 * override the texture and dividers.
 */
export function productionModes(creative, styleFixtures = readStyleFixtures()) {
  const ornament = creative.resolveOrnamentSettings({});
  return [
    { name: 'plain', options: {} },
    { name: 'ornament', options: { ornament } },
    ...styleFixtures.map(({ name, spec }) => ({ name: `style:${name}`, options: { ornament, style: spec } })),
  ];
}

/**
 * What the gate records about one design in one mode: the hard-QA defect codes left after
 * preparation, each design metric preparation newly broke, and `worse` when preparation took a
 * design that passed QA on its own and broke it. A design with no tokens is clean and is not
 * recorded, so the baseline file lists only the known-bad and stays readable.
 */
export function verdictTokens(before, after) {
  const tokens = [];
  if (!after.qa.passed) for (const code of new Set(after.qa.defectCodes)) tokens.push(code);
  for (const m of after.metrics.failingMetrics) if (!before.metrics.failingMetrics.includes(m)) tokens.push(`metric:${m}`);
  if (before.qa.passed && !after.qa.passed) tokens.push('worse');
  return [...new Set(tokens)].sort();
}

/** Re-prepares one stored run in one mode and returns its tallies plus the not-clean designs. */
export function gradeRun(creative, context, runDir, modeOptions) {
  const briefsDir = path.join(runDir, 'briefs');
  const tally = { designs: 0, qaBefore: 0, qaPass: 0, qaAndMetrics: 0 };
  const defects = {};
  const notClean = {};
  for (const id of fs.readdirSync(briefsDir).sort()) {
    const layoutPath = path.join(briefsDir, id, 'layout.json');
    const briefPath = path.join(briefsDir, id, 'brief.json');
    if (!fs.existsSync(layoutPath) || !fs.existsSync(briefPath)) continue;
    const raw = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    const text = {};
    const scripts = {};
    const copyScripts = [];
    for (const block of brief.copyBlocks) {
      text[block.copyIndex] = block.text;
      scripts[block.copyIndex] = block.script;
      copyScripts[block.copyIndex] = block.script;
    }
    const copy = { text, scripts };
    const qaContext = {
      width: raw.width,
      height: raw.height,
      copyScripts,
      latinFont: context.reference.latinFont,
      arabicFont: context.reference.arabicFont,
      palette: context.reference.palette,
      logoAspect: context.logoAspect,
      copyText: text,
    };
    const judge = (layout) => ({
      metrics: creative.measureDesignV3(layout, copy),
      qa: creative.evaluateHardQa(layout, qaContext),
    });
    const before = judge(JSON.parse(JSON.stringify(raw)));
    const prepared = creative.prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(raw)), copy, {
      width: raw.width,
      height: raw.height,
      logoAspect: context.logoAspect,
      palette: context.reference.palette,
      ...modeOptions,
    });
    const after = judge(prepared);

    tally.designs++;
    if (before.qa.passed) tally.qaBefore++;
    if (after.qa.passed) tally.qaPass++;
    if (after.qa.passed && after.metrics.passed) tally.qaAndMetrics++;
    for (const code of new Set(after.qa.defectCodes)) defects[code] = (defects[code] || 0) + 1;
    const tokens = verdictTokens(before, after);
    if (tokens.length) notClean[id] = tokens.join(' ');
  }
  return { ...tally, defects, notClean };
}

/**
 * Compares this run's grading against the baseline entry for the same mode and run, design by
 * design, because totals hide a swap: one design starting to fail while another starts to pass
 * leaves 195/200 reading 195/200. A run the baseline holds with a different design count is not
 * compared at all and is fatal, because the corpus on disk is not the corpus the numbers came from
 * and every difference would be noise.
 */
export function compareToBaseline(graded, recorded) {
  // A run nobody has recorded yet is a fresh qualification: its designs have never been measured,
  // so they cannot be worse than anything. Reported, never failed.
  if (!recorded) return { comparable: false, fatal: false, why: 'not in the baseline yet', regressions: [], improvements: [] };
  if (recorded.designs !== graded.designs) {
    // A recorded run whose design count moved is the failure this gate exists to stop: the numbers
    // would be compared against a different set of designs and mean nothing.
    return {
      comparable: false,
      fatal: true,
      why: `baseline recorded ${recorded.designs} designs, this corpus has ${graded.designs}`,
      regressions: [],
      improvements: [],
    };
  }
  const regressions = [];
  const improvements = [];
  const ids = new Set([...Object.keys(graded.notClean), ...Object.keys(recorded.notClean || {})]);
  for (const id of [...ids].sort()) {
    const now = (graded.notClean[id] || '').split(' ').filter(Boolean);
    const then = ((recorded.notClean || {})[id] || '').split(' ').filter(Boolean);
    const added = now.filter((t) => !then.includes(t));
    const gone = then.filter((t) => !now.includes(t));
    if (added.length) regressions.push(`${id}: new ${added.join(', ')}`);
    if (gone.length) improvements.push(`${id}: fixed ${gone.join(', ')}`);
  }
  return { comparable: true, fatal: false, why: '', regressions, improvements };
}

async function main(argv) {
  const update = argv.includes('--update-baseline');
  const runs = argv.filter((a) => a !== '--update-baseline');
  if (!runs.length || argv.includes('--help')) {
    console.error('usage: node scripts/proofs/reprepare_stored_runs.mjs [--update-baseline] <runDir> [...]');
    process.exit(2);
  }

  const creative = await import(path.join(ROOT, 'packages/creative/dist/index.js'));
  const reference = creative.studioReferenceFromRaw(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/creative/assets/kaae-reference.json'), 'utf8'))
  );
  // The official logo's width over height, from its PNG header, as the studio computes it.
  const logoPng = fs.readFileSync(path.join(ROOT, 'packages/creative/assets/logos/kaae-official-logo.png'));
  const logoAspect = logoPng.readUInt32BE(16) / (logoPng.readUInt32BE(20) || 1);
  const context = { reference, logoAspect };

  const present = [];
  for (const run of runs) {
    if (!fs.existsSync(path.join(run, 'briefs'))) {
      // The corpus is gitignored, so a missing run is a checkout without it, not a broken gate.
      console.log(`-- ${run}: no briefs directory, skipped`);
      continue;
    }
    present.push(run);
  }
  if (!present.length) {
    console.error('no stored designs found; the corpus lives under output/proofs/ and is gitignored');
    process.exit(2);
  }

  const modes = productionModes(creative);
  const baseline = !update && fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : null;
  if (!update && !baseline) {
    console.error(`no baseline at ${BASELINE_PATH}; record one with --update-baseline`);
    process.exit(2);
  }

  // The local date, not the UTC one: every dated note in this repo is the operator's day, and at
  // 01:28 +0300 `toISOString()` stamped a baseline recorded on the 20th as the 19th.
  const now = new Date();
  const recordedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const record = {
    recordedAt,
    note:
      'Hard QA and design metrics after preparation, per mode, over the gitignored corpus under ' +
      'output/proofs/. Recorded from a real run of this gate on the committed tree, not ' +
      'a target: on 2026-09-20 at 81bb4f5 the style mode passes hard QA on 194 of 200 designs ' +
      'against 195 for plain, and 20 of 200 pass QA and the design metrics together against 48. ' +
      'Those failures are written down so the gate can see the next change, not because they are ' +
      'acceptable. Re-record only for a deliberate improvement, and say in the commit which numbers ' +
      'moved and why.',
    modes: {},
  };
  let regressions = 0;
  let unusable = 0;
  for (const mode of modes) {
    console.log(`== mode ${mode.name}`);
    const totals = { designs: 0, qaPass: 0, qaAndMetrics: 0 };
    const modeDefects = {};
    record.modes[mode.name] = { totals, runs: {} };
    const known = baseline?.modes?.[mode.name];
    if (baseline && !known) {
      // A mode with no recorded numbers is usually a style fixture somebody added. The whole point
      // of the baseline is that a new reference cannot reach production ungated, so this fails.
      console.error(`  NOT IN BASELINE: no recorded numbers for this mode; re-record with --update-baseline`);
      unusable++;
    }
    for (const run of present) {
      const graded = gradeRun(creative, context, run, mode.options);
      const key = path.basename(run.replace(/\/+$/, ''));
      record.modes[mode.name].runs[key] = {
        designs: graded.designs,
        qaPass: graded.qaPass,
        qaAndMetrics: graded.qaAndMetrics,
        notClean: graded.notClean,
      };
      totals.designs += graded.designs;
      totals.qaPass += graded.qaPass;
      totals.qaAndMetrics += graded.qaAndMetrics;
      for (const [code, n] of Object.entries(graded.defects)) modeDefects[code] = (modeDefects[code] || 0) + n;
      console.log(
        `  ${key}: QA ${graded.qaBefore}/${graded.designs} before, ${graded.qaPass}/${graded.designs} after; ` +
          `QA and metrics together: ${graded.qaAndMetrics}/${graded.designs}; defects: ${JSON.stringify(graded.defects)}`
      );
      if (update || !known) continue;
      const cmp = compareToBaseline(graded, known.runs?.[key]);
      if (!cmp.comparable) {
        if (cmp.fatal) {
          console.error(`    NOT COMPARED: ${cmp.why}`);
          unusable++;
        } else {
          console.log(`    not compared: ${cmp.why}`);
        }
        continue;
      }
      for (const line of cmp.improvements) console.log(`    improvement ${line}`);
      for (const line of cmp.regressions) console.error(`    REGRESSION ${line}`);
      regressions += cmp.regressions.length;
    }
    // A run the baseline holds but this corpus does not is lost coverage, not a regression: say so,
    // because the gate is only as good as the runs the operator still has on disk.
    const absent = Object.keys(known?.runs || {}).filter((k) => !(k in record.modes[mode.name].runs));
    if (absent.length) console.log(`  not on this machine: ${absent.join(', ')}`);
    console.log(
      `  TOTAL ${mode.name}: QA ${totals.qaPass}/${totals.designs}; ` +
        `QA and metrics together: ${totals.qaAndMetrics}/${totals.designs}; defects: ${JSON.stringify(modeDefects)}`
    );
  }

  if (update) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nbaseline written to ${BASELINE_PATH}`);
    return;
  }
  if (unusable) {
    console.error(`\n${unusable} mode(s) or run(s) could not be compared against the baseline`);
    process.exit(1);
  }
  if (regressions) {
    console.error(`\n${regressions} design(s) worse than the baseline`);
    process.exit(1);
  }
  console.log('\nno design is worse than the baseline');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main(process.argv.slice(2));
}
