import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildPairwiseJudgeSystemPrompt,
  evaluatePairOrder,
  JUDGE_DIMENSIONS,
  PHOTO_JUDGE_DIMENSIONS,
  POSTER_IMPACT_CRITERIA,
  POSTER_METRICS_RULE,
  type AnyJudgeDimension,
} from '../src/studio/pairwise-judge-v3.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';

/**
 * ADR-274 (owner-approved 2026-10-02, item 4 of the design plan): a poster client's judge is told the
 * metrics are facts about legibility and safety, not taste; negative space is no longer a virtue of a
 * poster's composition; the poster criteria are stronger; and, behind a switch, it may see one of the
 * office's published posts as the standard. Every other client's judge reads exactly what it read.
 */

const receipt = { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
const verdict = (dims: AnyJudgeDimension[]) => ({
  ...(dims.length > 5 ? { artDirection: Object.fromEntries(['A', 'B'].map((k) => [k, {
    heroFitsSubject: true, photoBoldAndDominant: true, textOnPlateCardOrFade: true, conceptConnection: true, photosTiledInGrid: false, houseRulesBroken: [],
  }])) } : {}),
  dimensions: Object.fromEntries(dims.map((d) => [d, { winner: 'A', rationale: 'r' }])),
  majorityWinner: 'A', summary: 's',
});
const client = (dims: AnyJudgeDimension[] = JUDGE_DIMENSIONS) =>
  ({ createStructuredCompletion: vi.fn().mockResolvedValue({ data: verdict(dims), receipt }) }) as any;
const png = Buffer.from('not decoded by the judge');
const [A, B] = [SIX_CONFIRMED_EXEMPLARS[0], SIX_CONFIRMED_EXEMPLARS[1]];
const brief = { instructions: 'Keep it formal', copy: [{ copyIndex: 0, text: 'Quality Assurance Workshop', role: 'title' }] };
const houseRules = ['Guideline fidelity (brand fit): a rule'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const call = (c: any) => c.createStructuredCompletion.mock.calls[0][0];
const system = (c: any) => call(c).messages[0].content as string;
const user = (c: any) => call(c).messages[1].content[0].text as string;
const images = (c: any) => call(c).messages[1].content.filter((p: any) => p.type === 'image_url');
const judge = async (options: Record<string, unknown>, photoBrief = false) => {
  const c = client(photoBrief ? PHOTO_JUDGE_DIMENSIONS : JUDGE_DIMENSIONS);
  await evaluatePairOrder({ id: 'a', layout: A, renderedPng: png }, { id: 'b', layout: B, renderedPng: png }, 'AB',
    { client: c, model: 'gpt-4.1-mini', brief, houseRules, clientProfile: 'An accreditation agency.', photoBrief, ...options });
  return c;
};

describe('other clients\' judge reads exactly what it read before ADR-274', () => {
  // sha256 of the system prompt and the user text at e7aebad7 (the base of this change), for the
  // same inputs: the typographic and the photo brief, with house rules, a client profile and a brief.
  // The system prompts are those of e7aebad7. The user texts were re-pinned after ADR-273: its
  // recalibrated metrics change the composite score quoted in the user text (0.926 -> 0.934 here);
  // the wording is unchanged.
  it('keeps the typographic system prompt and user text byte-identical', async () => {
    const c = await judge({});
    expect(sha(system(c))).toBe('8f933bfc2a7689358462247a7116f718f5cdb708f80a75382a8f1e14833bd46b');
    expect(sha(user(c))).toBe('eaea88053cef45effb81e0c2ac416216874989b5347a09b13ff1faa4bc796113');
    expect(images(c)).toHaveLength(2);
  });

  it('keeps the photo-brief system prompt and user text byte-identical', async () => {
    const c = await judge({}, true);
    expect(sha(system(c))).toBe('5e685f2ce0bac0ff805afa7ee1a47138d0febbc180ee9534cf7b5452b5ffc3c7');
    expect(sha(user(c))).toBe('96bba5a76d5f4cb876eb46a02a8ddf625f4e0b3420a8696dbcfbef6be35b0ba2');
  });

  it('never attaches an office post without posterImpact', async () => {
    const c = await judge({ officeReference: { dataUrl: 'data:image/jpeg;base64,AAAA', label: 'photo11' } });
    expect(images(c)).toHaveLength(2);
    expect(user(c)).not.toMatch(/published posts/);
  });
});

describe('a poster client\'s judge (ADR-274)', () => {
  it('reads the metrics as facts about legibility and safety, not taste, in both prompts', () => {
    for (const photoBrief of [false, true]) {
      const prompt = buildPairwiseJudgeSystemPrompt({ photoBrief, posterImpact: true });
      expect(prompt).toContain(POSTER_METRICS_RULE);
      expect(prompt).not.toMatch(/You must take them into account/);
      expect(prompt).toContain(POSTER_IMPACT_CRITERIA.composition);
      expect(prompt).toContain(POSTER_IMPACT_CRITERIA.hierarchy);
      expect(prompt).toContain(POSTER_IMPACT_CRITERIA.brand_fit);
    }
  });

  it('no longer counts negative space as a virtue of a poster\'s composition', () => {
    const poster = buildPairwiseJudgeSystemPrompt({ photoBrief: false, posterImpact: true });
    expect(poster).toMatch(/2\. composition: balance, grid discipline, alignment, framing\. A clear focal point/);
    expect(poster).not.toMatch(/negative space/);
    expect(POSTER_IMPACT_CRITERIA.composition).toMatch(/Empty canvas is not a virtue/);
    expect(buildPairwiseJudgeSystemPrompt({ photoBrief: false })).toMatch(/alignment, negative space, framing/);
  });

  it('is strengthened: impact at feed size, the focal point and imagery, the client\'s own posts and the brief', () => {
    expect(POSTER_IMPACT_CRITERIA.hierarchy).toMatch(/300px-wide thumbnail/);
    expect(POSTER_IMPACT_CRITERIA.hierarchy).toMatch(/Impact at feed size/);
    expect(POSTER_IMPACT_CRITERIA.composition).toMatch(/focal point/);
    expect(POSTER_IMPACT_CRITERIA.composition).toMatch(/photograph/);
    expect(POSTER_IMPACT_CRITERIA.brand_fit).toMatch(/requester's instructions/);
    expect(POSTER_IMPACT_CRITERIA.brand_fit).toMatch(/own published posts/);
  });

  it('is shown the legibility facts only; the composite, balance, regularity and alignment are withheld', async () => {
    const c = await judge({ posterImpact: true });
    const text = user(c);
    expect(text).toMatch(/LEGIBILITY FACTS/);
    expect(text).toMatch(/Text Legibility: \d\.\d{3}/);
    expect(text).toMatch(/Type Scale: \d\.\d{3}/);
    expect(text).not.toMatch(/Composite Score|Balance:|Regularity:|Alignment:|GROUND TRUTH/);
    expect(text).toMatch(/withheld/);
    expect(text).toContain('Keep it formal');
    expect(text).toContain('across all 5 dimensions');
    const photo = await judge({ posterImpact: true }, true);
    expect(user(photo)).toMatch(/PHOTOS PLACED/);
    expect(user(photo)).not.toMatch(/Composite Score/);
  });

  it('sees one office post as the standard, not to copy, only in a free image slot', async () => {
    const office = { dataUrl: 'data:image/jpeg;base64,AAAA', label: 'photo11_peer_evaluators_call_en.jpg: the Call for Peer Evaluators post' };
    const c = await judge({ posterImpact: true, officeReference: office });
    expect(images(c)).toHaveLength(3);
    expect(images(c)[2].image_url.url).toBe(office.dataUrl);
    expect(user(c)).toMatch(/Image 3 is one of the client's own published posts/);
    expect(user(c)).toMatch(/the standard, not a design to copy/);
    // A requester's reference keeps the slot.
    const reference = { dataUrl: 'data:image/png;base64,BBBB', notes: 'their poster' };
    const withRef = await judge({ posterImpact: true, officeReference: office, reference });
    expect(images(withRef)).toHaveLength(3);
    expect(images(withRef)[2].image_url.url).toBe(reference.dataUrl);
    expect(user(withRef)).not.toMatch(/published posts/);
    // No office post given: two images.
    expect(images(await judge({ posterImpact: true }))).toHaveLength(2);
  });
});
