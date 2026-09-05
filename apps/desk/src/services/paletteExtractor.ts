/**
 * Hawa Creative OS — Client Logo & Image Palette Auto-Extractor
 * 
 * Extracts dominant, secondary, and accent colors from client logos (.svg, .png, .webp)
 * using client-side 2D Canvas pixel quantization, and calculates WCAG 2.1 relative
 * luminance contrast ratios for accessible brand governance.
 */

export interface ExtractedPalette {
  primary: string;
  secondary: string;
  accent: string;
  cardBg: string;
  dominantHex: string;
  swatches: string[];
  contrastRatioOnWhite: number;
  contrastRatioOnDark: number;
  wcagGrade: 'AAA' | 'AA' | 'FAIL';
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

/**
 * Calculates WCAG 2.1 Relative Luminance (sRGB standard)
 */
export function getRelativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const sRGB = [rgb.r / 255, rgb.g / 255, rgb.b / 255].map((val) => {
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
}

/**
 * Calculates WCAG 2.1 Contrast Ratio between two hex colors
 */
export function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(hexToRgb(hex1));
  const lum2 = getRelativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  const ratio = (brightest + 0.05) / (darkest + 0.05);
  return Math.round(ratio * 100) / 100;
}

/**
 * Extracts palette from an HTMLImageElement or Canvas
 */
export function extractPaletteFromImageData(ctx: CanvasRenderingContext2D, width: number, height: number): ExtractedPalette {
  const imgData = ctx.getImageData(0, 0, width, height).data;
  const colorBuckets = new Map<string, { count: number; r: number; g: number; b: number }>();

  // Quantize into 16-step bins
  const step = 4; // sample every 4th pixel for high performance
  for (let i = 0; i < imgData.length; i += 4 * step) {
    const a = imgData[i + 3];
    if (a < 80) continue; // skip transparent

    const r = imgData[i];
    const g = imgData[i + 1];
    const b = imgData[i + 2];

    // Filter out near pure white and near pure black to find distinct brand hues
    const isNearWhite = r > 240 && g > 240 && b > 240;
    const isNearBlack = r < 20 && g < 20 && b < 20;

    const binR = Math.round(r / 24) * 24;
    const binG = Math.round(g / 24) * 24;
    const binB = Math.round(b / 24) * 24;
    const key = `${binR},${binG},${binB}`;

    const weight = isNearWhite || isNearBlack ? 0.2 : 1.0;
    const current = colorBuckets.get(key) || { count: 0, r: binR, g: binG, b: binB };
    current.count += weight;
    colorBuckets.set(key, current);
  }

  // Sort buckets by count
  const sorted = Array.from(colorBuckets.values()).sort((a, b) => b.count - a.count);

  const swatches: string[] = [];
  for (const bucket of sorted) {
    const hex = rgbToHex(bucket.r, bucket.g, bucket.b);
    if (!swatches.includes(hex)) {
      swatches.push(hex);
    }
    if (swatches.length >= 6) break;
  }

  // Fallbacks if image was transparent or monotone
  const primary = swatches[0] || '#01585F';
  const secondary = swatches[1] || '#0A1C1F';
  const accent = swatches[2] || '#F59E0B';
  const cardBg = swatches[3] || '#FFFFFF';

  const ratioWhite = getContrastRatio(primary, '#FFFFFF');
  const ratioDark = getContrastRatio(primary, '#0F172A');
  const maxRatio = Math.max(ratioWhite, ratioDark);

  const wcagGrade = maxRatio >= 7.0 ? 'AAA' : maxRatio >= 4.5 ? 'AA' : 'FAIL';

  return {
    primary,
    secondary,
    accent,
    cardBg,
    dominantHex: primary,
    swatches,
    contrastRatioOnWhite: ratioWhite,
    contrastRatioOnDark: ratioDark,
    wcagGrade,
  };
}

/**
 * Extracts palette directly from a File or Blob (.png, .svg, .jpg, .webp)
 */
export async function extractPaletteFromFile(file: File | Blob): Promise<ExtractedPalette> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 200; // downsample for instant analysis
        const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas 2D context'));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          const palette = extractPaletteFromImageData(ctx, canvas.width, canvas.height);
          resolve(palette);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to load image file into canvas'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file bytes'));
    reader.readAsDataURL(file);
  });
}
