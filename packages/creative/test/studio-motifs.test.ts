import { describe, it, expect } from 'vitest';
import {
  generateMotifSvg,
  renderMotifPng,
  type ProceduralMotifType,
} from '../src/studio/motifs.js';

const KAAE_PALETTE = [
  '#0A1628',
  '#1E3A5F',
  '#4770A3',
  '#D4E2F0',
  '#F7B500',
  '#FDF8F3',
  '#FFFFFF',
];

const MOTIF_TYPES: ProceduralMotifType[] = [
  'guilloche',
  'sun-rays',
  'thin-rules',
  'gradient-wash',
];

describe('Design Studio v2: Procedural Motifs (generateMotifSvg & renderMotifPng)', () => {
  for (const type of MOTIF_TYPES) {
    describe(`Motif: ${type}`, () => {
      it('is completely deterministic given a seed', () => {
        const svg1 = generateMotifSvg(type, {
          width: 1080,
          height: 1350,
          palette: KAAE_PALETTE,
          seed: 98765,
        });
        const svg2 = generateMotifSvg(type, {
          width: 1080,
          height: 1350,
          palette: KAAE_PALETTE,
          seed: 98765,
        });
        expect(svg1).toBe(svg2);

        const svgDifferentSeed = generateMotifSvg(type, {
          width: 1080,
          height: 1350,
          palette: KAAE_PALETTE,
          seed: 54321,
        });
        expect(svg1).not.toBe(svgDifferentSeed);
      });

      it('contains zero <text> or <tspan> elements', () => {
        const svg = generateMotifSvg(type, {
          width: 1080,
          height: 1350,
          palette: KAAE_PALETTE,
          seed: 1234,
        });
        expect(svg.toLowerCase()).not.toContain('<text');
        expect(svg.toLowerCase()).not.toContain('<tspan');
      });

      it('uses ONLY palette colors and no foreign or unapproved colors', () => {
        const customPalette = ['#0A1628', '#F7B500', '#FFFFFF'];
        const svg = generateMotifSvg(type, {
          width: 1080,
          height: 1350,
          palette: customPalette,
          seed: 42,
        });

        // Extract all hex colors
        const hexMatches = svg.match(/#[0-9a-fA-F]{6}/g) || [];
        expect(hexMatches.length).toBeGreaterThan(0);

        const normalizedPalette = new Set(customPalette.map((c) => c.toUpperCase()));
        for (const hex of hexMatches) {
          expect(normalizedPalette.has(hex.toUpperCase())).toBe(true);
        }

        // Verify no named foreign colors
        const forbiddenNamedColors = ['red', 'green', 'blue', 'yellow', 'purple', 'black'];
        for (const color of forbiddenNamedColors) {
          expect(svg).not.toMatch(new RegExp(`fill="${color}"`, 'i'));
          expect(svg).not.toMatch(new RegExp(`stroke="${color}"`, 'i'));
        }
      });

      it('renders to valid 1x PNG buffer', () => {
        const png = renderMotifPng(type, {
          width: 540,
          height: 675,
          palette: KAAE_PALETTE,
          seed: 101,
        });
        expect(png.length).toBeGreaterThan(1000);
        // Verify PNG magic header: 0x89 'P' 'N' 'G' 0x0D 0x0A 0x1A 0x0A
        expect(png[0]).toBe(0x89);
        expect(png[1]).toBe(0x50);
        expect(png[2]).toBe(0x4e);
        expect(png[3]).toBe(0x47);
      });
    });
  }
});
