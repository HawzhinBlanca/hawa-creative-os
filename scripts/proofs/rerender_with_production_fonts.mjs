/**
 * Re-renders qualification layouts inside the production image, where the bundled fonts are
 * installed and fc-cached, so the preview PNGs show the typography production actually produces.
 *
 * The macOS dev host resolves only the system-installed families; rsvg-convert there silently
 * substitutes Helvetica for Cinzel, Playfair Display and Cairo, so previews rendered locally
 * misrepresent every heading. Rendering is deterministic and costs no model calls.
 *
 * Usage (from the repo root):
 *   docker run --rm \
 *     -v "$PWD/packages/creative/dist:/app/packages/creative/dist:ro" \
 *     -v "$PWD/output:/work/output" \
 *     -v "$PWD/scripts/proofs:/work/scripts:ro" \
 *     hawa-core:<tag> node /work/scripts/rerender_with_production_fonts.mjs <briefsDir> <outDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const mod = await import('/app/packages/creative/dist/studio/render-layout-v2.js');
const { renderLayoutV2, getFontFidelityManifest } = mod;

const briefsDir = process.argv[2];
const outDir = process.argv[3];
if (!briefsDir || !outDir) {
  console.error('usage: rerender_with_production_fonts.mjs <briefsDir> <outDir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const manifest = getFontFidelityManifest('/app/packages/creative/assets/fonts');
console.log('font fidelity measured in this container:');
for (const [k, v] of Object.entries(manifest)) console.log(`  ${k.padEnd(20)}${v}`);

const report = { fontFidelity: manifest, renders: [] };

for (const name of fs.readdirSync(briefsDir).sort()) {
  const folder = path.join(briefsDir, name);
  const layoutPath = path.join(folder, 'layout.json');
  const briefPath = path.join(folder, 'brief.json');
  if (!fs.existsSync(layoutPath) || !fs.existsSync(briefPath)) continue;

  const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  const copyText = Object.fromEntries((brief.copyBlocks || []).map((b) => [b.copyIndex, b.text]));

  const familiesUsed = [...new Set((layout.text || []).map((t) => t.fontFamily).filter(Boolean))];
  const standIns = familiesUsed.filter((f) => manifest[f] === 'stand-in');

  const rendered = renderLayoutV2(layout, { copyText });
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeBriefId = String(brief.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const outPath = path.join(outDir, `${safeName}_${safeBriefId}.png`);
  fs.writeFileSync(outPath, rendered.png);

  const entry = {
    brief: brief.id,
    folder: name,
    size: `${layout.width}x${layout.height}`,
    familiesUsed,
    standIns,
    sha256: createHash('sha256').update(rendered.png).digest('hex'),
    bytes: rendered.png.length,
  };
  report.renders.push(entry);
  console.log(
    `${name} ${brief.id.padEnd(26)} ${entry.size.padEnd(10)} fonts=${familiesUsed.join('/')}` +
      (standIns.length ? `  STAND-IN: ${standIns.join(', ')}` : '')
  );
}

fs.writeFileSync(path.join(outDir, 'RERENDER_MANIFEST.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.renders.length} layouts re-rendered into ${outDir}`);
const bad = report.renders.filter((r) => r.standIns.length);
console.log(bad.length ? `WARNING: ${bad.length} still used a substituted face` : 'every family used renders exactly here');
