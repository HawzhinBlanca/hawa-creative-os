import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { creativeAssetPath, pageGrammarFromRaw } from '@hawa/creative';
import { judgeOfficeReferenceEnabled, officeReferenceForJudge } from '../src/services/design-studio/stages/v3.stage.js';

/**
 * ADR-274: a poster client's judge may be shown one of the office's own published posts as the
 * standard, not a design to copy. It adds an image (about $0.003-0.004) to every judge call, so it
 * is behind HAWA_JUDGE_OFFICE_REFERENCE and off by default.
 */
const REFERENCE = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8'));
const GRAMMAR = pageGrammarFromRaw(REFERENCE)!;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const post = readFileSync(creativeAssetPath('exemplars/photo11_peer_evaluators_call_en.jpg'));
const confirmed = readFileSync(creativeAssetPath('exemplars/post2_standards_higher_ed.png'));
const exemplars = [
  { path: 'post2_standards_higher_ed.png', label: 'post2: owner-confirmed', sha256: sha(confirmed), bytes: confirmed, mimeType: 'image/png' },
  { path: 'photo11_peer_evaluators_call_en.jpg', label: 'photo11_peer_evaluators_call_en.jpg: the Call for Peer Evaluators post', sha256: sha(post), bytes: post, mimeType: 'image/jpeg' },
];
const ctx = { clientId: REFERENCE.clientId as string, pageGrammar: GRAMMAR, reference: undefined, exemplars };
const ON = { HAWA_JUDGE_OFFICE_REFERENCE: 'on' };

describe('the office reference for the judge (ADR-274)', () => {
  it('is off by default', () => {
    expect(judgeOfficeReferenceEnabled({})).toBe(false);
    expect(judgeOfficeReferenceEnabled({ HAWA_JUDGE_OFFICE_REFERENCE: 'off' })).toBe(false);
    expect(officeReferenceForJudge(ctx, {})).toBeUndefined();
  });

  it('when on, is the first pinned exemplar that is an office-published post in the client\'s manifest', () => {
    for (const value of ['1', 'on', 'true', 'ON']) expect(judgeOfficeReferenceEnabled({ HAWA_JUDGE_OFFICE_REFERENCE: value })).toBe(true);
    const office = officeReferenceForJudge(ctx, ON)!;
    expect(office.label).toMatch(/^photo11_peer_evaluators_call_en\.jpg/);
    expect(office.dataUrl).toBe(`data:image/jpeg;base64,${post.toString('base64')}`);
  });

  it('is never shown for a client without poster rules, beside a requester reference, or for bytes the manifest does not name', () => {
    expect(officeReferenceForJudge({ ...ctx, pageGrammar: { ...GRAMMAR, poster: undefined } }, ON)).toBeUndefined();
    expect(officeReferenceForJudge({ ...ctx, reference: { dataUrl: 'data:image/png;base64,AA', notes: 'theirs' } }, ON)).toBeUndefined();
    const altered = Buffer.concat([post, Buffer.from([0])]);
    expect(officeReferenceForJudge({ ...ctx, exemplars: [{ ...exemplars[1], bytes: altered, sha256: sha(altered) }] }, ON)).toBeUndefined();
    expect(officeReferenceForJudge({ ...ctx, exemplars: [exemplars[0]] }, ON)).toBeUndefined();
  });
});
