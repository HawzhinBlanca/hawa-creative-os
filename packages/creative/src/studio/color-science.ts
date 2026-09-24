import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import type { Hex } from './layout-v2.js';
import { sniffImageType } from './image-type.js';

export interface LabColor {
  L: number;
  a: number;
  b: number;
  chroma: number;
}

export interface DominantColorSample {
  hex: Hex;
  rgb: [number, number, number];
  frequency: number;
  chroma: number;
  isNeutral: boolean;
  nearestPaletteColor: Hex;
  minDeltaE: number;
  passed: boolean;
}

export interface PaletteVerificationResult {
  passed: boolean;
  dominantColors: DominantColorSample[];
  summary: string;
}

export function hexToRgb(hex: Hex): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function rgbToHex(r: number, g: number, b: number): Hex {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Converts sRGB [0..255] to CIE L*a*b* under D65 standard illuminant.
 */
export function rgbToLab([rIn, gIn, bIn]: [number, number, number]): LabColor {
  const srgb = [rIn, gIn, bIn].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });

  // Convert to XYZ under D65 illuminant
  const X = (srgb[0] * 0.4124564 + srgb[1] * 0.3575761 + srgb[2] * 0.1804375) / 0.95047;
  const Y = (srgb[0] * 0.2126729 + srgb[1] * 0.7151522 + srgb[2] * 0.0721750) / 1.00000;
  const Z = (srgb[0] * 0.0193339 + srgb[1] * 0.1191920 + srgb[2] * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 0.008856451679 ? Math.cbrt(t) : 7.787037 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);
  const chroma = Math.sqrt(a * a + b * b);

  return { L, a, b, chroma };
}

function degrees(rad: number): number {
  return rad * (180 / Math.PI);
}

function radians(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Computes CIEDE2000 color difference between two Lab colors.
 * Reference: Sharma, Wu, Dalal (2005) checklist.
 */
export function ciede2000(lab1: LabColor, lab2: LabColor): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const avgL = (L1 + L2) / 2;
  const c1 = Math.sqrt(a1 * a1 + b1 * b1);
  const c2 = Math.sqrt(a2 * a2 + b2 * b2);
  const avgC = (c1 + c2) / 2;

  const avgC7 = Math.pow(avgC, 7);
  const G = 0.5 * (1 - Math.sqrt(avgC7 / (avgC7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  const c1p = Math.sqrt(a1p * a1p + b1 * b1);
  const c2p = Math.sqrt(a2p * a2p + b2 * b2);
  const avgCp = (c1p + c2p) / 2;

  let h1p = degrees(Math.atan2(b1, a1p));
  if (h1p < 0) h1p += 360;
  let h2p = degrees(Math.atan2(b2, a2p));
  if (h2p < 0) h2p += 360;

  let deltahp = 0;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) {
      deltahp = h2p - h1p;
    } else if (h2p <= h1p) {
      deltahp = h2p - h1p + 360;
    } else {
      deltahp = h2p - h1p - 360;
    }
  }

  const deltaLp = L2 - L1;
  const deltaCp = c2p - c1p;
  const deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(radians(deltahp / 2));

  let avghp = 0;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) {
      avghp = (h1p + h2p) / 2;
    } else if (h1p + h2p < 360) {
      avghp = (h1p + h2p + 360) / 2;
    } else {
      avghp = (h1p + h2p - 360) / 2;
    }
  } else {
    avghp = h1p + h2p;
  }

  const T =
    1 -
    0.17 * Math.cos(radians(avghp - 30)) +
    0.24 * Math.cos(radians(2 * avghp)) +
    0.32 * Math.cos(radians(3 * avghp + 6)) -
    0.2 * Math.cos(radians(4 * avghp - 63));

  const deltaTheta = 30 * Math.exp(-Math.pow((avghp - 275) / 25, 2));
  const avgCp7 = Math.pow(avgCp, 7);
  const RC = 2 * Math.sqrt(avgCp7 / (avgCp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(avgL - 50, 2)) / Math.sqrt(20 + Math.pow(avgL - 50, 2));
  const SC = 1 + 0.045 * avgCp;
  const SH = 1 + 0.015 * avgCp * T;
  const RT = -Math.sin(radians(2 * deltaTheta)) * RC;

  return Math.sqrt(
    Math.pow(deltaLp / SL, 2) +
      Math.pow(deltaCp / SC, 2) +
      Math.pow(deltaHp / SH, 2) +
      RT * (deltaCp / SC) * (deltaHp / SH)
  );
}

/**
 * Decodes image to raw RGBA pixel data, downscaling to 128x160 for rapid color sampling.
 */
function decodeToThumbnail(imageBuffer: Buffer, mimeType: string): { width: number; height: number; data: Buffer } {
  const isPng = imageBuffer.length > 8 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4e && imageBuffer[3] === 0x47;

  // If pure PNG and small enough, parse directly
  if (isPng) {
    try {
      const parsed = PNG.sync.read(imageBuffer);
      if (parsed.width <= 256 && parsed.height <= 256) {
        return parsed;
      }
    } catch {
      // fallback to rsvg-convert
    }
  }

  // Downsample to 128x160 via rsvg-convert
  const rsvgPath = fs.existsSync('/opt/homebrew/bin/rsvg-convert')
    ? '/opt/homebrew/bin/rsvg-convert'
    : fs.existsSync('/usr/bin/rsvg-convert')
    ? '/usr/bin/rsvg-convert'
    : 'rsvg-convert';

  const base64Data = imageBuffer.toString('base64');
  // The bytes name the decoder, not the declared type: librsvg picks its loader from the data URI.
  const safeMime = sniffImageType(imageBuffer) || mimeType || 'image/jpeg';
  const svg = `<svg width="128" height="160" viewBox="0 0 128 160" xmlns="http://www.w3.org/2000/svg">
  <image width="128" height="160" href="data:${safeMime};base64,${base64Data}"/>
</svg>`;

  try {
    const res = spawnSync(rsvgPath, ['-w', '128', '-h', '160', '-f', 'png'], {
      input: svg,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10000,
    });

    if (res.status === 0 && res.stdout && res.stdout.length > 50) {
      return PNG.sync.read(res.stdout);
    }
  } catch {
    // rsvg failed or not installed, fallback if PNG
  }

  if (isPng) {
    return PNG.sync.read(imageBuffer);
  }

  throw new Error('Unable to decode image for dominant color extraction (requires rsvg-convert or PNG buffer)');
}

/**
 * Extracts the 5 most frequent dominant colors from an image buffer using 5-bit color quantization.
 */
export function extractDominantColors(
  imageBuffer: Buffer,
  mimeType: string,
  palette: Hex[]
): DominantColorSample[] {
  const thumb = decodeToThumbnail(imageBuffer, mimeType);
  const stride = Math.max(1, Math.floor(thumb.width / 128));

  const bins = new Map<number, { count: number; rSum: number; gSum: number; bSum: number }>();
  let totalSampled = 0;

  for (let y = 0; y < thumb.height; y += stride) {
    for (let x = 0; x < thumb.width; x += stride) {
      const idx = (thumb.width * y + x) << 2;
      const r = thumb.data[idx];
      const g = thumb.data[idx + 1];
      const b = thumb.data[idx + 2];
      const a = thumb.data[idx + 3];

      if (a < 128) continue; // Skip transparent

      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const entry = bins.get(key);
      if (entry) {
        entry.count++;
        entry.rSum += r;
        entry.gSum += g;
        entry.bSum += b;
      } else {
        bins.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
      }
      totalSampled++;
    }
  }

  if (totalSampled === 0) {
    return [];
  }

  const sortedBins = Array.from(bins.values()).sort((a, b) => b.count - a.count);
  const pickedClusters: Array<{ r: number; g: number; b: number; count: number }> = [];

  for (const bin of sortedBins) {
    const r = Math.round(bin.rSum / bin.count);
    const g = Math.round(bin.gSum / bin.count);
    const b = Math.round(bin.bSum / bin.count);

    // Filter clusters too close in Euclidean RGB space to provide 5 distinct dominant tones
    const tooClose = pickedClusters.some((p) => {
      const dr = p.r - r;
      const dg = p.g - g;
      const db = p.b - b;
      return Math.sqrt(dr * dr + dg * dg + db * db) < 22;
    });

    if (!tooClose) {
      pickedClusters.push({ r, g, b, count: bin.count });
      if (pickedClusters.length === 5) break;
    }
  }

  // If fewer than 5 distinct clusters found, fill with remaining bins regardless of proximity
  if (pickedClusters.length < 5) {
    for (const bin of sortedBins) {
      const r = Math.round(bin.rSum / bin.count);
      const g = Math.round(bin.gSum / bin.count);
      const b = Math.round(bin.bSum / bin.count);
      const exists = pickedClusters.some((p) => p.r === r && p.g === g && p.b === b);
      if (!exists) {
        pickedClusters.push({ r, g, b, count: bin.count });
        if (pickedClusters.length === 5) break;
      }
    }
  }

  const paletteLabs = palette.map((hex) => ({
    hex,
    lab: rgbToLab(hexToRgb(hex)),
  }));

  return pickedClusters.map((cluster) => {
    const lab = rgbToLab([cluster.r, cluster.g, cluster.b]);
    let minDeltaE = Infinity;
    let nearestPaletteColor = palette[0] || '#000000';

    for (const p of paletteLabs) {
      const dE = ciede2000(lab, p.lab);
      if (dE < minDeltaE) {
        minDeltaE = dE;
        nearestPaletteColor = p.hex;
      }
    }

    const isNeutral = lab.chroma < 8;
    const passed = isNeutral || minDeltaE <= 25;

    return {
      hex: rgbToHex(cluster.r, cluster.g, cluster.b),
      rgb: [cluster.r, cluster.g, cluster.b],
      frequency: Number((cluster.count / totalSampled).toFixed(4)),
      chroma: Number(lab.chroma.toFixed(2)),
      isNeutral,
      nearestPaletteColor,
      minDeltaE: Number(minDeltaE.toFixed(2)),
      passed,
    };
  });
}

/**
 * Validates dominant colors against ADR 029 rule:
 * "dominant-colour check — the five most frequent colours (k-means or histogram bins)
 * must each be within ΔE2000 ≤ 25 of a palette colour or be a neutral (chroma < 8);"
 */
export function verifyPaletteCompliance(
  imageBuffer: Buffer,
  mimeType: string,
  palette: Hex[]
): PaletteVerificationResult {
  const dominantColors = extractDominantColors(imageBuffer, mimeType, palette);
  const passed = dominantColors.length > 0 && dominantColors.every((c) => c.passed);
  const failedCount = dominantColors.filter((c) => !c.passed).length;

  const summary = passed
    ? `All ${dominantColors.length} dominant colors satisfy palette ΔE2000 ≤ 25 or neutral chroma < 8`
    : `${failedCount} of ${dominantColors.length} dominant colors violate palette constraint (ΔE2000 > 25 and chroma ≥ 8)`;

  return {
    passed,
    dominantColors,
    summary,
  };
}
