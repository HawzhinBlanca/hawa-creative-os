import { describe, it, expect } from 'vitest';
import { savedDesignCopy, unwrapCopyEnvelope } from '../src/services/canva-design-planner.js';

// Task b6621947 (2026-09-18): the requester wrapped the copy in brackets and added a remark after
// the close. A lone "(" became the title block and the remark was printed in the footer.
const RAW = [
  'I need an invitation design for Kaae. Don’t change anything from my content.',
  '__________',
  '',
  '(THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION',
  '',
  'Mr. / Ms. / Dr. [Full Name]',
  '',
  'The ministers will sign a Memorandum of Understanding (MoU) at the launch.',
  '',
  'By Invitation Only',
  '',
  'This invitation is personal and non-transferable.',
  'Kindly do not share this invitation.) make sure you do a new pro design , at good as u can',
].join('\n');

describe('copy wrapped in brackets or quotes', () => {
  it('drops the marks, keeps brackets inside the copy, and moves the remark after the close to the instructions', () => {
    const { copy, instructions } = savedDesignCopy({ payload: { rawRequestText: RAW } }, '');
    expect(copy[0]).toBe('THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION');
    expect(copy).toContain('The ministers will sign a Memorandum of Understanding (MoU) at the launch.');
    expect(copy[copy.length - 1]).toBe('This invitation is personal and non-transferable.\nKindly do not share this invitation.');
    expect(copy.join(' ')).not.toMatch(/pro design|^\(/);
    expect(instructions).toContain('make sure you do a new pro design');
  });

  it('leaves copy exactly as written when brackets do not wrap it', () => {
    const draft = '(Draft) Annual Gala\n\nJoin us on 9 September.';
    expect(unwrapCopyEnvelope(draft)).toEqual({ copy: draft, trailing: '' });
    const unclosed = '(Annual Gala\n\nJoin us on 9 September.';
    expect(unwrapCopyEnvelope(unclosed)).toEqual({ copy: unclosed, trailing: '' });
    expect(unwrapCopyEnvelope('Annual Gala (2026)')).toEqual({ copy: 'Annual Gala (2026)', trailing: '' });
    expect(unwrapCopyEnvelope('(1) Opening remarks\n\n(2) Keynote')).toEqual({ copy: '(1) Opening remarks\n\n(2) Keynote', trailing: '' });
    expect(unwrapCopyEnvelope('(Coming soon)')).toEqual({ copy: '(Coming soon)', trailing: '' });
  });

  it('unwraps quotes too, and a wrapped copy with nothing after it', () => {
    expect(unwrapCopyEnvelope('“Annual Gala\n\nJoin us.” please keep it simple')).toEqual({ copy: 'Annual Gala\n\nJoin us.', trailing: 'please keep it simple' });
    expect(unwrapCopyEnvelope('[Annual Gala\n\nJoin us.]')).toEqual({ copy: 'Annual Gala\n\nJoin us.', trailing: '' });
  });
});
