import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Hex } from './layout-v2.js';
import { defaultFontsDir, pinnedFontconfigFile, rasteriserEnv } from './font-environment.js';

export type ProceduralMotifType = 'guilloche' | 'sun-rays' | 'thin-rules' | 'gradient-wash' | 'diagonal-lines';

export interface MotifOptions {
  width: number;
  height: number;
  palette: Hex[];
  seed?: number;
  opacity?: number;
}

/**
 * Neutral greys for a motif drawn without a palette. It was KAAE's palette, so a motif for any
 * client that passed none came out in KAAE's navy and gold (ADR-038). Callers pass the client's.
 */
const DEFAULT_PALETTE: Hex[] = ['#1A1A1A', '#3A3A3A', '#6B6B6B', '#BDBDBD', '#FFFFFF'];

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 */
export function createPrng(seed = 12345678): () => number {
  let s = Math.floor(seed) >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizePalette(palette?: Hex[]): Hex[] {
  if (!palette || palette.length === 0) return DEFAULT_PALETTE;
  return palette.map((c) => c.toUpperCase());
}

/**
 * Generates an intricate academic/diplomatic Guilloche spirograph curve set.
 */
function generateGuillocheSvg(
  width: number,
  height: number,
  palette: Hex[],
  prng: () => number,
  globalOpacity: number
): string {
  const cx = width / 2;
  const cy = height * 0.45;
  const maxR = Math.min(width, height) * 0.42;

  const paths: string[] = [];
  const numLayers = 3 + Math.floor(prng() * 3); // 3 to 5 layers

  for (let l = 0; l < numLayers; l++) {
    const color = palette[Math.floor(prng() * palette.length)];
    const opacity = (0.2 + prng() * 0.5) * globalOpacity;
    const strokeW = 1 + prng() * 1.5;

    const R = maxR * (0.6 + prng() * 0.4);
    const r = R * (0.15 + prng() * 0.25);
    const d = r * (0.8 + prng() * 1.2);
    const steps = 600;
    const revolutions = 6 + Math.floor(prng() * 6);

    let dPath = '';
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * (revolutions * 2 * Math.PI);
      const x = cx + (R - r) * Math.cos(theta) + d * Math.cos(((R - r) / r) * theta);
      const y = cy + (R - r) * Math.sin(theta) - d * Math.sin(((R - r) / r) * theta);
      if (i === 0) {
        dPath += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
      } else {
        dPath += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
    }
    paths.push(
      `<path d="${dPath}" fill="none" stroke="${color}" stroke-width="${strokeW.toFixed(1)}" opacity="${opacity.toFixed(2)}"/>`
    );
  }

  return paths.join('\n  ');
}

/**
 * Generates radial Sun-Rays radiating outward from an institutional horizon.
 */
function generateSunRaysSvg(
  width: number,
  height: number,
  palette: Hex[],
  prng: () => number,
  globalOpacity: number
): string {
  const cx = width / 2;
  const cy = height * 0.35;
  const rayCount = 24 + Math.floor(prng() * 12) * 2; // 24 to 48 rays
  const maxDist = Math.hypot(width, height);

  const elements: string[] = [];
  const primaryColor = palette[Math.floor(prng() * palette.length)];
  const secondaryColor = palette[Math.floor(prng() * palette.length)];

  for (let i = 0; i < rayCount; i++) {
    const angle1 = (i / rayCount) * 2 * Math.PI;
    const angle2 = ((i + 0.45) / rayCount) * 2 * Math.PI;

    const x1 = cx + maxDist * Math.cos(angle1);
    const y1 = cy + maxDist * Math.sin(angle1);
    const x2 = cx + maxDist * Math.cos(angle2);
    const y2 = cy + maxDist * Math.sin(angle2);

    const color = i % 2 === 0 ? primaryColor : secondaryColor;
    const opacity = (i % 2 === 0 ? 0.08 : 0.04) * globalOpacity;

    elements.push(
      `<polygon points="${cx.toFixed(1)},${cy.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="${color}" opacity="${opacity.toFixed(3)}"/>`
    );
  }

  return elements.join('\n  ');
}

/**
 * Generates an architectural grid of thin rules and precision corner registration marks.
 */
function generateThinRulesSvg(
  width: number,
  height: number,
  palette: Hex[],
  prng: () => number,
  globalOpacity: number
): string {
  const elements: string[] = [];
  const margin = Math.round(Math.min(width, height) * 0.08);
  const color = palette[Math.floor(prng() * palette.length)];
  const accentColor = palette[Math.floor(prng() * palette.length)];

  // Outer border
  elements.push(
    `<rect x="${margin}" y="${margin}" width="${width - 2 * margin}" height="${height - 2 * margin}" fill="none" stroke="${color}" stroke-width="1.5" opacity="${(0.5 * globalOpacity).toFixed(2)}"/>`
  );

  // Inner inset border
  const inset = margin + 16;
  elements.push(
    `<rect x="${inset}" y="${inset}" width="${width - 2 * inset}" height="${height - 2 * inset}" fill="none" stroke="${color}" stroke-width="0.75" stroke-dasharray="8 6" opacity="${(0.35 * globalOpacity).toFixed(2)}"/>`
  );

  // 4 Corner registration brackets
  const bracketLen = 24;
  const corners = [
    { x: margin, y: margin, dx: 1, dy: 1 },
    { x: width - margin, y: margin, dx: -1, dy: 1 },
    { x: margin, y: height - margin, dx: 1, dy: -1 },
    { x: width - margin, y: height - margin, dx: -1, dy: -1 },
  ];

  for (const c of corners) {
    elements.push(
      `<path d="M ${c.x} ${c.y + c.dy * bracketLen} L ${c.x} ${c.y} L ${c.x + c.dx * bracketLen} ${c.y}" fill="none" stroke="${accentColor}" stroke-width="2" opacity="${(0.8 * globalOpacity).toFixed(2)}"/>`
    );
  }

  // Geometric center grid ticks
  const midX = width / 2;
  const midY = height / 2;
  elements.push(
    `<line x1="${midX - 15}" y1="${margin}" x2="${midX + 15}" y2="${margin}" stroke="${accentColor}" stroke-width="1.5" opacity="${(0.7 * globalOpacity).toFixed(2)}"/>`,
    `<line x1="${midX - 15}" y1="${height - margin}" x2="${midX + 15}" y2="${height - margin}" stroke="${accentColor}" stroke-width="1.5" opacity="${(0.7 * globalOpacity).toFixed(2)}"/>`,
    `<line x1="${margin}" y1="${midY - 15}" x2="${margin}" y2="${midY + 15}" stroke="${accentColor}" stroke-width="1.5" opacity="${(0.7 * globalOpacity).toFixed(2)}"/>`,
    `<line x1="${width - margin}" y1="${midY - 15}" x2="${width - margin}" y2="${midY + 15}" stroke="${accentColor}" stroke-width="1.5" opacity="${(0.7 * globalOpacity).toFixed(2)}"/>`
  );

  return elements.join('\n  ');
}

/**
 * Generates a smooth multi-stop gradient wash across palette tones.
 */
function generateGradientWashSvg(
  width: number,
  height: number,
  palette: Hex[],
  prng: () => number,
  globalOpacity: number
): string {
  const gradId = `wash-grad-${Math.floor(prng() * 100000)}`;
  const c1 = palette[0] || DEFAULT_PALETTE[0];
  const c2 = palette[1 % palette.length] || DEFAULT_PALETTE[1];
  const c3 = palette[2 % palette.length] || DEFAULT_PALETTE[2];

  const isRadial = prng() > 0.5;

  let defs = '';
  if (isRadial) {
    defs = `<radialGradient id="${gradId}" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="${c3}" stop-opacity="${(0.7 * globalOpacity).toFixed(2)}"/>
      <stop offset="60%" stop-color="${c2}" stop-opacity="${(0.85 * globalOpacity).toFixed(2)}"/>
      <stop offset="100%" stop-color="${c1}" stop-opacity="${(1.0 * globalOpacity).toFixed(2)}"/>
    </radialGradient>`;
  } else {
    defs = `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c1}" stop-opacity="${(0.95 * globalOpacity).toFixed(2)}"/>
      <stop offset="45%" stop-color="${c2}" stop-opacity="${(0.85 * globalOpacity).toFixed(2)}"/>
      <stop offset="100%" stop-color="${c3}" stop-opacity="${(0.7 * globalOpacity).toFixed(2)}"/>
    </linearGradient>`;
  }

  return `<defs>\n    ${defs}\n  </defs>\n  <rect width="${width}" height="${height}" fill="url(#${gradId})"/>`;
}

/**
 * Fine parallel hairlines rising left to right over a diagonal tonal split: the lower-right half a
 * step lighter than the field. The texture of the owner's K-12 reference (task 89c242f2).
 */
function generateDiagonalLinesSvg(width: number, height: number, palette: Hex[], globalOpacity: number): string {
  // The palette colours nearest a deep blue (the lighter plane) and a mid blue (the lines). The two
  // are only points in colour space: what is drawn is always the client's own colours. (Sorting by
  // lightness instead picked a near-black from a palette with several dark tones.)
  const plane = nearestTo('#1E3A5F', palette);
  const line = nearestTo('#4770A3', palette);
  const spacing = Math.max(14, Math.round(Math.min(width, height) / 60));
  const lines: string[] = [];
  for (let c = -height; c < width + height; c += spacing) {
    lines.push(`<line x1="${c}" y1="${height}" x2="${c + height}" y2="0"/>`);
  }
  return [
    `<polygon points="${width},${Math.round(height * 0.12)} ${width},${height} 0,${height} 0,${Math.round(height * 0.95)}" fill="${plane}" opacity="${(1.0 * globalOpacity).toFixed(2)}"/>`,
    `<g stroke="${line}" stroke-width="1.2" opacity="${(0.55 * globalOpacity).toFixed(2)}">`,
    ...lines,
    `</g>`,
  ].join('\n  ');
}

function nearestTo(want: Hex, palette: Hex[]): Hex {
  const rgb = (hex: string) => {
    const c = hex.replace('#', '');
    const f = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
  };
  const [r, g, b] = rgb(want);
  const d = (h: string) => {
    const [x, y, z] = rgb(h);
    return (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
  };
  return [...palette].sort((p, q) => d(p) - d(q))[0] || want;
}

/**
 * Deterministically generates an SVG string for a given procedural motif.
 * Enforces palette-only colors, no text elements, and identical output per seed.
 */
export function generateMotifSvg(type: ProceduralMotifType, options: MotifOptions): string {
  const prng = createPrng(options.seed ?? 42);
  const palette = normalizePalette(options.palette);
  const opacity = options.opacity ?? 1.0;
  const width = options.width;
  const height = options.height;

  let innerSvg = '';
  switch (type) {
    case 'guilloche':
      innerSvg = generateGuillocheSvg(width, height, palette, prng, opacity);
      break;
    case 'sun-rays':
      innerSvg = generateSunRaysSvg(width, height, palette, prng, opacity);
      break;
    case 'thin-rules':
      innerSvg = generateThinRulesSvg(width, height, palette, prng, opacity);
      break;
    case 'gradient-wash':
      innerSvg = generateGradientWashSvg(width, height, palette, prng, opacity);
      break;
    case 'diagonal-lines':
      innerSvg = generateDiagonalLinesSvg(width, height, palette, opacity);
      break;
    default:
      throw new Error(`Unknown motif type: ${type}`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${innerSvg}
</svg>`.trim();
}

/**
 * Renders a procedural motif directly to a 1x PNG buffer using rsvg-convert.
 */
export function renderMotifPng(type: ProceduralMotifType, options: MotifOptions): Buffer {
  const svg = generateMotifSvg(type, options);
  const tempDir = fs.mkdtempSync(path.join(tmpdir(), 'hawa-motif-'));
  const svgPath = path.join(tempDir, `${type}.svg`);

  try {
    fs.writeFileSync(svgPath, svg, 'utf-8');
    const rsvgPath = fs.existsSync('/opt/homebrew/bin/rsvg-convert')
      ? '/opt/homebrew/bin/rsvg-convert'
      : 'rsvg-convert';

    const result = spawnSync(
      rsvgPath,
      ['-w', String(options.width), '-h', String(options.height), '-f', 'png', svgPath],
      // Motifs carry no text today; the pinned environment keeps it that way if one ever does.
      { env: rasteriserEnv(pinnedFontconfigFile(defaultFontsDir())), maxBuffer: 32 * 1024 * 1024, timeout: 15000 }
    );

    if (result.status !== 0 || !result.stdout || result.stdout.length < 100) {
      throw new Error(`Failed to render motif PNG (${type}): status ${result.status}`);
    }
    return result.stdout;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
