import fs from 'node:fs';
import path from 'node:path';
import type { StudioGoldenBrief } from './types.js';

function getBriefsDirectory(): string {
  const primary = path.resolve('packages/evals/src/design-studio/briefs');
  if (fs.existsSync(primary)) return primary;
  const secondary = path.resolve(process.cwd(), 'packages/evals/src/design-studio/briefs');
  if (fs.existsSync(secondary)) return secondary;
  const tertiary = path.resolve(__dirname, 'briefs');
  if (fs.existsSync(tertiary)) return tertiary;
  throw new Error(`Could not locate briefs directory at ${primary}`);
}

export function validateBrief(brief: StudioGoldenBrief): void {
  if (!brief.id || typeof brief.id !== 'string') {
    throw new Error(`Brief missing valid id: ${JSON.stringify(brief)}`);
  }
  if (!['en', 'ckb', 'mixed'].includes(brief.language)) {
    throw new Error(`Brief ${brief.id} has invalid language ${brief.language}`);
  }
  if (typeof brief.width !== 'number' || typeof brief.height !== 'number' || brief.width <= 0 || brief.height <= 0) {
    throw new Error(`Brief ${brief.id} has invalid dimensions ${brief.width}x${brief.height}`);
  }
  if (!Array.isArray(brief.copyBlocks) || brief.copyBlocks.length === 0) {
    throw new Error(`Brief ${brief.id} has no copy blocks`);
  }

  // Check contiguous 0-indexed copy blocks
  const indices = brief.copyBlocks.map((b) => b.copyIndex).sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i) {
      throw new Error(`Brief ${brief.id} has non-contiguous copyIndex at ${i} (got ${indices[i]})`);
    }
  }

  for (const block of brief.copyBlocks) {
    if (!block.text || block.text.trim().length === 0) {
      throw new Error(`Brief ${brief.id} has empty copy block at index ${block.copyIndex}`);
    }
    if (!['latin', 'arabic'].includes(block.script)) {
      throw new Error(`Brief ${brief.id} block ${block.copyIndex} has invalid script ${block.script}`);
    }
  }
}

export function loadGoldenBriefs(): StudioGoldenBrief[] {
  const dir = getBriefsDirectory();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('golden-') && f.endsWith('.json'))
    .sort();

  const briefs: StudioGoldenBrief[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const brief = JSON.parse(content) as StudioGoldenBrief;
    validateBrief(brief);
    briefs.push(brief);
  }

  return briefs;
}

export function loadCompareBriefs(): StudioGoldenBrief[] {
  const dir = getBriefsDirectory();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('compare-') && f.endsWith('.json'))
    .sort();

  const briefs: StudioGoldenBrief[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const brief = JSON.parse(content) as StudioGoldenBrief;
    validateBrief(brief);
    briefs.push(brief);
  }

  return briefs;
}

export function getBriefById(id: string): StudioGoldenBrief | undefined {
  const all = [...loadGoldenBriefs(), ...loadCompareBriefs()];
  return all.find((b) => b.id === id || b.compareId === id);
}
