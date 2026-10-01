/** Existing recipe typography policy; this search changes no size floor or hierarchy. */
export interface RecipeTypeScalePolicy {
  naturalTitle: number;
  naturalBody: number;
  minimumBody: number;
  minimumFont: number;
  titleToBodyMinimum: number;
}
export interface RecipeTypeScale {
  title: number;
  accent: number;
  body: number;
  footer: number;
}
export const TYPE_SCALE_SEARCH_LIMITS = Object.freeze({ transitions: 1024, states: 512 });

function scaleAt(policy: RecipeTypeScalePolicy, factor: number): RecipeTypeScale {
  const body = Math.max(policy.minimumBody, Math.round(policy.naturalBody * Math.min(1, factor + 0.12)));
  const title = Math.max(Math.ceil(policy.titleToBodyMinimum * body), Math.round(policy.naturalTitle * factor));
  return { title, accent: Math.round(title * 0.92), body,
    footer: Math.max(policy.minimumFont, Math.min(body, Math.round(body * 0.82))) };
}

/**
 * Every size changes only when natural title/body rounding changes. Sample each interval and
 * both endpoints, including adjacent values around floating-point rounding ties. Descending
 * states let the caller measure actual copy/geometry without assuming feasibility is monotone.
 * Bounds apply before glyph measurement or allocation proportional to untrusted canvas sizes.
 */
export function candidateRecipeTypeScales(policy: RecipeTypeScalePolicy, minimumFactor = 0.5): RecipeTypeScale[] {
  if (!Number.isFinite(minimumFactor) || minimumFactor < 0 || minimumFactor > 1 ||
      ![policy.naturalTitle, policy.naturalBody, policy.titleToBodyMinimum].every(n => Number.isFinite(n) && n > 0) ||
      ![policy.minimumBody, policy.minimumFont].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new RangeError('TYPE_SCALE_SEARCH_INVALID: finite positive policy and a factor from zero to one required');
  }
  const ranges = [{ rate: policy.naturalTitle, offset: 0 }, { rate: policy.naturalBody, offset: 0.12 }]
    .map(({ rate, offset }) => ({ rate, offset,
      first: Math.ceil(rate * Math.min(1, minimumFactor + offset) - 0.5),
      last: Math.floor(rate - 0.5) }));
  const transitions = ranges.reduce((sum, r) => sum + Math.max(0, r.last - r.first + 1), 0);
  if (ranges.some(r => !Number.isSafeInteger(r.first) || !Number.isSafeInteger(r.last)) ||
      !Number.isSafeInteger(transitions) || transitions > TYPE_SCALE_SEARCH_LIMITS.transitions) {
    throw new RangeError('TYPE_SCALE_SEARCH_LIMIT: rounding transition budget exceeded');
  }
  const boundaries = new Set([minimumFactor, 1]);
  for (const { rate, offset, first, last } of ranges) {
    for (let n = first; n <= last; n++) {
      const point = (n + 0.5) / rate - offset;
      if (point >= minimumFactor && point <= 1) boundaries.add(point);
    }
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const factors = new Set<number>();
  for (const [i, point] of ordered.entries()) {
    const guard = Number.EPSILON * 4;
    for (const value of [point, point - guard, point + guard]) {
      if (value >= minimumFactor && value <= 1) factors.add(value);
    }
    if (i) factors.add((point + ordered[i - 1]) / 2);
  }
  const states: RecipeTypeScale[] = [], seen = new Set<string>();
  for (const factor of [...factors].sort((a, b) => b - a)) {
    const scale = scaleAt(policy, factor);
    if (!Object.values(scale).every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new RangeError('TYPE_SCALE_SEARCH_LIMIT: type size exceeds safe integer range');
    }
    const key = `${scale.title},${scale.accent},${scale.body},${scale.footer}`;
    if (seen.has(key)) continue;
    seen.add(key); states.push(scale);
    if (states.length > TYPE_SCALE_SEARCH_LIMITS.states) {
      throw new RangeError('TYPE_SCALE_SEARCH_LIMIT: distinct scale budget exceeded');
    }
  }
  return states;
}
