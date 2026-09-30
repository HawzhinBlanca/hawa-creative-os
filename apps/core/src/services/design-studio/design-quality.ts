import { createHash } from 'node:crypto';
import { photoSelectionOrUndefined, splitCopyByLineScript, type PhotoSelection } from '@hawa/creative';
import type { CopyBlock } from './types.js';

/**
 * ADR-157: the studio's copy blocks from the request's copy. A block whose lines are in two scripts
 * becomes one block per run of lines, so an English line is never set right to left in the Sorani
 * face its block was given; the renderer and the Canva deck set a whole block in one face and one
 * direction. A split part's language is not the labelled field's, so it is left undetermined.
 */
export function studioCopyBlocks(
  copy: string[],
  scripts: Array<'latin' | 'arabic' | 'unsupported'>,
  locales: string[]
): CopyBlock[] {
  return copy.flatMap((text, idx): CopyBlock[] => {
    const parts = splitCopyByLineScript(text);
    if (parts.length > 1) return parts.map((part) => ({ text: part.text, script: part.script, locale: 'und' }));
    return [{
      text,
      script: scripts[idx] === 'arabic' ? 'arabic' : 'latin',
      locale: locales[idx],
      localeCopySha256: createHash('sha256').update(text).digest('hex'),
    }];
  });
}

/**
 * ADR-157: whether the requester let the design choose among the photos, as the run's brief
 * recorded it. A change to a design keeps its parent's brief, and with it this choice.
 */
export function recordedPhotoSelection(brief: unknown, photoCount: number): PhotoSelection | undefined {
  return photoSelectionOrUndefined((brief as { photoSelection?: unknown } | undefined)?.photoSelection, photoCount);
}
