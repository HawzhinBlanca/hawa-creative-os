import fs from 'node:fs';
import path from 'node:path';
import {
  generateMotifSvg,
  renderMotifPng,
  type ProceduralMotifType,
} from '../packages/creative/src/studio/motifs.js';

const KAAE_PALETTE = [
  '#0A1628', // Midnight Navy
  '#1E3A5F', // Royal Navy
  '#4770A3', // KAAE Primary Blue
  '#D4E2F0', // Sky Ice Blue
  '#F7B500', // Kurdistan Sun Gold
  '#FDF8F3', // Academic Cream
  '#FFFFFF', // Pure White
];

const MOTIFS: ProceduralMotifType[] = [
  'guilloche',
  'sun-rays',
  'thin-rules',
  'gradient-wash',
];

async function main() {
  const outputDir = path.resolve(
    process.cwd(),
    'output/proofs/2026-09-14-design-studio-v2/T06_MOTIFS'
  );
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const manifest: Record<string, { svgBytes: number; pngBytes: number; sha256?: string }> = {};

  for (const motif of MOTIFS) {
    console.log(`Generating motif: ${motif}...`);
    const svg = generateMotifSvg(motif, {
      width: 1080,
      height: 1350,
      palette: KAAE_PALETTE,
      seed: 20260914,
    });

    const png = renderMotifPng(motif, {
      width: 1080,
      height: 1350,
      palette: KAAE_PALETTE,
      seed: 20260914,
    });

    const svgPath = path.join(outputDir, `${motif}.svg`);
    const pngPath = path.join(outputDir, `${motif}.png`);

    fs.writeFileSync(svgPath, svg, 'utf-8');
    fs.writeFileSync(pngPath, png);

    manifest[motif] = {
      svgBytes: svg.length,
      pngBytes: png.length,
    };
    console.log(`  ${motif}: SVG ${svg.length} bytes, PNG ${png.length} bytes`);
  }

  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  console.log('Motifs generated successfully in', outputDir);
}

if (process.argv[1] && process.argv[1].endsWith('generate_t06_motifs.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
