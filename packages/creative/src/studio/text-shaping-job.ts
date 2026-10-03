import { PNG } from 'pngjs';
import { checkTextShaping, textShapingBlocks, type ShapingTextBlock, type TextShapingFidelity } from './export-text-shaping.js';
import { defaultFontsDir } from './font-environment.js';

/**
 * ADR-290 addendum: one Sorani shaping check as plain data, so it can run on a worker thread
 * (`text-shaping-pool.ts`) exactly as it runs in-process. Everything is structured-cloneable: pictures
 * are PNG bytes, faces are paths under `fontsDir` (never parsed font objects), and the result is the
 * report `checkTextShaping` returns. Both the blocks (`textShapingBlocks`: fontkit fitting and the
 * Pango fallback query) and the check itself run here, because both are synchronous CPU work.
 */
export interface TextShapingJob {
  /** The picture to read, as PNG bytes (a Studio render or a provider's export). */
  picture: Uint8Array;
  /** The same picture without its text (the Studio renderer's `noTextPng`): ink is then read exactly. */
  background?: Uint8Array;
  /** The text blocks of the layout, or of the transfer plan a provider's design was imported from. */
  layout: { text?: ShapingTextBlock[] };
  copyText: Record<number, string>;
  /** Picture pixels per layout pixel. */
  scale?: number;
  /** The layout's width: the scale is the picture's width over it (a provider's export). */
  planWidth?: number;
  /** Extra ink colours by copy index (a run coloured apart in the deck). */
  colors?: Record<number, string[]>;
  allScripts?: boolean;
  /** The pinned fonts folder the blocks are measured and drawn from; the caller's, resolved by the caller. */
  fontsDir?: string;
}

export interface TextShapingNotMeasured { measured: false; reason: string }
export type TextShapingOutcome = TextShapingFidelity | TextShapingNotMeasured;

export const NO_SHAPING_TEXT = 'The design has no Kurdish or Arabic text to check.';

const bytesOf = (b: Uint8Array): Buffer => Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);

/** Runs one job in this thread. Throws what `textShapingBlocks` or `checkTextShaping` throws. */
export function runTextShapingJob(job: TextShapingJob): TextShapingOutcome {
  const picture = PNG.sync.read(bytesOf(job.picture));
  const background = job.background ? PNG.sync.read(bytesOf(job.background)) : undefined;
  const scale = job.planWidth ? picture.width / job.planWidth : job.scale;
  const blocks = textShapingBlocks(job.layout, job.copyText, {
    fontsDir: job.fontsDir || defaultFontsDir(),
    ...(scale !== undefined ? { scale } : {}),
    ...(job.colors ? { colors: job.colors } : {}),
    ...(job.allScripts ? { allScripts: true } : {}),
  });
  if (!blocks.length) return { measured: false, reason: NO_SHAPING_TEXT };
  return checkTextShaping(picture, blocks, background ? { background } : {});
}
