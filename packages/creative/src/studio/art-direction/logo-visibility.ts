import { calculateLuminanceContrastRatio, rgbToLuminance } from '../luminance.js';

/** ADR172 W3. Local engineering screen; thresholds still require human/archive calibration. */
export const LOGO_FEATURE_COVERAGE = 0.9;
export const LOGO_COMPONENT_COVERAGE = 0.8;
const MAX_PIXELS = 1024 * 1024;
type Raster = { width: number; height: number; data: Uint8Array };
type Feature = { a: number; b: number; contrast: number; direction: number };
export interface LogoVisibilityTemplate {
  width: number;
  height: number;
  components: readonly (readonly Feature[])[];
}
export interface LogoVisibilityReading {
  method: 'source-edges-v1';
  coverage: number;
  worstComponent: number;
  componentCount: number;
  featureCount: number;
  passed: boolean;
}

function validRaster(r: Raster): void {
  if (!Number.isInteger(r.width) || !Number.isInteger(r.height) || r.width < 1 || r.height < 1 ||
      r.width * r.height > MAX_PIXELS || r.data.length !== r.width * r.height * 4) {
    throw new Error('LOGO_UNMEASURED: invalid or unbounded logo raster');
  }
}
const luminance = (r: Raster, p: number, ground?: number): number => {
  const i = p * 4, alpha = ground === undefined ? 1 : r.data[i + 3] / 255;
  return rgbToLuminance(
    alpha * r.data[i] + (1 - alpha) * (ground ?? 0),
    alpha * r.data[i + 1] + (1 - alpha) * (ground ?? 0),
    alpha * r.data[i + 2] + (1 - alpha) * (ground ?? 0));
};
const feature = (r: Raster, a: number, b: number, ground: number): Feature => {
  const x = luminance(r, a, ground), y = luminance(r, b, ground);
  return { a, b, contrast: calculateLuminanceContrastRatio(x, y), direction: Math.sign(x - y) };
};

/**
 * Alpha defines source components even where the artwork is invisible on the actual background.
 * Strong internal edges qualify an approved opaque plate without requiring its outer border to
 * contrast with the paper. Flat letters need their alpha boundary. No source pixels are changed.
 */
export function compileLogoVisibility(r: Raster): LogoVisibilityTemplate {
  validRaster(r);
  const n = r.width * r.height, labels = new Int32Array(n).fill(-1), groups: number[][] = [];
  let foreground = 0;
  for (let p = 0; p < n; p++) if (r.data[p * 4 + 3] >= 192) foreground++;
  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] !== -1 || r.data[seed * 4 + 3] < 192) continue;
    const id = groups.length, points = [seed]; labels[seed] = id;
    for (let q = 0; q < points.length; q++) {
      const p = points[q], x = p % r.width, y = Math.floor(p / r.width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx >= r.width || ny < 0 || ny >= r.height) continue;
        const k = ny * r.width + nx;
        if (labels[k] === -1 && r.data[k * 4 + 3] >= 192) { labels[k] = id; points.push(k); }
      }
    }
    groups.push(points);
  }
  const components: Feature[][] = [];
  // Ignore subpixel debris; retain small meaningful letters/dots at the placed size.
  const minArea = Math.max(3, Math.ceil(foreground * 0.001));
  for (let id = 0; id < groups.length; id++) {
    const points = groups[id];
    if (points.length < minArea) continue;
    const internal: Feature[] = [], boundary: Feature[] = [];
    for (const p of points) {
      const x = p % r.width, y = Math.floor(p / r.width);
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= r.width || ny < 0 || ny >= r.height) continue;
        const k = ny * r.width + nx;
        if (labels[k] === id) {
          const f = feature(r, p, k, 255);
          if (f.contrast >= 1.8) internal.push(f);
        } else if (r.data[k * 4 + 3] <= 32) {
          const white = feature(r, p, k, 255), black = feature(r, p, k, 0);
          const f = white.contrast >= black.contrast ? white : black;
          if (f.contrast >= 3) boundary.push({ ...f, direction: 0 });
        }
      }
    }
    const edges = internal.length >= Math.max(8, points.length * 0.02) ? internal : boundary;
    if (!edges.length) throw new Error('LOGO_UNMEASURED: meaningful source component has no measurable features');
    components.push(edges);
  }
  if (!components.length) throw new Error('LOGO_UNMEASURED: source has no measurable artwork features at this size');
  return { width: r.width, height: r.height, components };
}

/** Actual source-aligned pixel edges, including each component; no saved "passed" flag is trusted. */
export function readLogoVisibility(actual: Raster, template: LogoVisibilityTemplate): LogoVisibilityReading {
  validRaster(actual);
  if (actual.width !== template.width || actual.height !== template.height || !template.components.length ||
      template.components.length > actual.width * actual.height) {
    throw new Error('LOGO_UNMEASURED: source signature does not match rendered logo geometry');
  }
  let visible = 0, count = 0, worst = 1;
  for (const edges of template.components) {
    if (!edges.length) throw new Error('LOGO_UNMEASURED: empty artwork component');
    if (count + edges.length > actual.width * actual.height * 4) throw new Error('LOGO_UNMEASURED: unbounded source features');
    let componentVisible = 0;
    for (const f of edges) {
      if (!Number.isInteger(f.a) || !Number.isInteger(f.b) || f.a < 0 || f.b < 0 ||
          f.a >= actual.width * actual.height || f.b >= actual.width * actual.height ||
          !Number.isFinite(f.contrast) || f.contrast < 1 || f.contrast > 21) {
        throw new Error('LOGO_UNMEASURED: invalid source feature');
      }
      if (f.direction !== -1 && f.direction !== 0 && f.direction !== 1) throw new Error('LOGO_UNMEASURED: invalid source edge direction');
      const a = luminance(actual, f.a), b = luminance(actual, f.b);
      // Boundary polarity can reverse on a light/dark ground; intrinsic edges cannot. The
      // contrast requirement preserves thin approved details relative to their source baseline.
      const c = calculateLuminanceContrastRatio(a, b);
      if (c >= Math.min(3, 0.9 * f.contrast) && (f.direction === 0 || Math.sign(a - b) === f.direction)) componentVisible++;
    }
    visible += componentVisible; count += edges.length;
    worst = Math.min(worst, componentVisible / edges.length);
  }
  const coverage = count ? visible / count : 0;
  return { method: 'source-edges-v1', coverage, worstComponent: worst,
    componentCount: template.components.length, featureCount: count,
    passed: coverage >= LOGO_FEATURE_COVERAGE && worst >= LOGO_COMPONENT_COVERAGE };
}
