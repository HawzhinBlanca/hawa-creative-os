import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateArtImage, composeArtPrompt } from '../src/studio/gemini-image-provider.js';
import { extractDominantColors, verifyPaletteCompliance } from '../src/studio/color-science.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import type { Hex } from '../src/studio/layout-v2.js';

async function runLiveProbe() {
  console.log('=== Starting T07 Art Provider Live Probe ===');

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey || !anthropicKey) {
    throw new Error('GEMINI_API_KEY and ANTHROPIC_API_KEY must be set for live probe');
  }

  const KAAE_PALETTE: Hex[] = [
    '#0A1628', // Midnight Navy
    '#1E3A5F', // Royal Navy
    '#4770A3', // KAAE Primary Blue
    '#D4E2F0', // Sky Ice Blue
    '#F7B500', // Kurdistan Sun Gold
    '#FDF8F3', // Academic Cream
    '#FFFFFF', // Pure White
  ];

  const conceptPrompt = 'Abstract minimalist Kurdish mountain horizon at dawn, layered architectural geometry and subtle atmospheric mist in deep navy and sky ice blue with delicate gold morning illumination';
  const calmRegion = 'lower half and center';
  const aspect = '4:5';

  const composedPrompt = composeArtPrompt(conceptPrompt, {
    palette: KAAE_PALETTE,
    calmRegion,
    aspect,
  });

  console.log('Composed Art Prompt:');
  console.log(composedPrompt);
  console.log('----------------------------------------------------');

  const startTime = Date.now();
  const result = await generateArtImage({
    artPrompt: conceptPrompt,
    palette: KAAE_PALETTE,
    calmRegionDescription: calmRegion,
    aspect,
    width: 1080,
    height: 1350,
    geminiApiKey: geminiKey,
    anthropicApiKey: anthropicKey,
  });
  const durationMs = Date.now() - startTime;

  console.log(`Generation completed in ${durationMs}ms`);
  console.log('Receipt:', JSON.stringify(result.receipt, null, 2));

  // Ensure output directory exists
  const outDir = path.resolve('output/proofs/2026-09-14-design-studio-v2/T07_ART');
  fs.mkdirSync(outDir, { recursive: true });

  // Save image as probe.png (convert JPEG to PNG via rsvg if returned as JPEG)
  const probePngPath = path.join(outDir, 'probe.png');

  let finalPngBuffer: Buffer;
  if (result.mimeType === 'image/png') {
    finalPngBuffer = result.imageBuffer;
  } else {
    // Render to PNG buffer using rsvg-convert
    const { spawnSync } = await import('node:child_process');
    const rsvgPath = fs.existsSync('/opt/homebrew/bin/rsvg-convert')
      ? '/opt/homebrew/bin/rsvg-convert'
      : 'rsvg-convert';
    const svg = `<svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
  <image width="1080" height="1350" href="data:${result.mimeType};base64,${result.imageBuffer.toString('base64')}"/>
</svg>`;
    const rsvgRes = spawnSync(rsvgPath, ['-w', '1080', '-h', '1350', '-f', 'png'], {
      input: svg,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (rsvgRes.status !== 0 || !rsvgRes.stdout) {
      throw new Error(`Failed to rasterize probe image to PNG: status ${rsvgRes.status}`);
    }
    finalPngBuffer = rsvgRes.stdout;
  }

  fs.writeFileSync(probePngPath, finalPngBuffer);
  const probeSha256 = crypto.createHash('sha256').update(finalPngBuffer).digest('hex');
  console.log(`Saved probe image to ${probePngPath}`);
  console.log(`Probe PNG size: ${finalPngBuffer.length} bytes, SHA-256: ${probeSha256}`);

  // Re-verify dominant colors on final PNG
  const compliance = verifyPaletteCompliance(finalPngBuffer, 'image/png', KAAE_PALETTE);
  console.log('\n=== Palette Dominant Colors (CIEDE2000) ===');
  console.table(compliance.dominantColors);
  console.log('Palette Check Result:', compliance.passed ? 'PASSED' : 'FAILED');

  // Save probe metadata
  const metaPath = path.join(outDir, 'probe_meta.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        conceptPrompt,
        composedPrompt,
        durationMs,
        receipt: result.receipt,
        probeSha256,
        probePngBytes: finalPngBuffer.length,
        dominantColors: compliance.dominantColors,
        palettePassed: compliance.passed,
      },
      null,
      2
    )
  );

  console.log(`Saved probe metadata to ${metaPath}`);
}

runLiveProbe().catch((err) => {
  console.error('Fatal error during T07 live probe:', err);
  process.exit(1);
});
