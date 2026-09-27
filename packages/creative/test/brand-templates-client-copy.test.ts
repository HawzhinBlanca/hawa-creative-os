import { describe, it, expect } from 'vitest';
import type { StudioOperation } from '@hawa/contracts';
import { buildAsterHealthcareTemplate, buildDrusteeClinicalTemplate, buildFastpayPromoTemplate } from '../src/templates/index.js';
import { renderOperationsToSvg } from '../src/operations-to-svg.js';

// Client copy is never invented: the brand templates draw what the client sent and nothing else.
const TEMPLATES = [
  { brand: 'fastpay', build: buildFastpayPromoTemplate, width: 1080, height: 1080 },
  { brand: 'aster', build: buildAsterHealthcareTemplate, width: 1080, height: 1350 },
  { brand: 'drustee', build: buildDrusteeClinicalTemplate, width: 1080, height: 1080 },
] as const;

const KURDISH = { headlineCkb: 'سەردێڕی کڕیار', copyCkb: 'دەقی کڕیار بۆ ئەم پۆستە' };
const ENGLISH = { headlineEn: 'The client headline', copyEn: 'The client body copy' };

const texts = (ops: StudioOperation[]) =>
  ops.flatMap((op) => (op.op === 'addText' ? [op.text.replace(/[⁧⁩]/g, '')] : []));
const vectorSources = (ops: StudioOperation[]) => ops.flatMap((op) => (op.op === 'addVector' ? [op.source] : []));

describe.each(TEMPLATES)('$brand template', ({ brand, build, width, height }) => {
  it('draws only the Kurdish copy for a Kurdish-only request', () => {
    const ops = build(KURDISH);
    expect(texts(ops)).toEqual([KURDISH.headlineCkb, KURDISH.copyCkb]);
    expect(() => renderOperationsToSvg(ops, width, height)).not.toThrow();
  });

  it('draws only the English copy for an English-only request, with the English headline as the headline', () => {
    const ops = build(ENGLISH);
    expect(texts(ops)).toEqual([ENGLISH.headlineEn, ENGLISH.copyEn]);
    const headline = ops.find((op): op is Extract<StudioOperation, {op: 'addText'}> => op.op === 'addText' && op.nodeId === `${brand}_headline_en`);
    expect(headline).toMatchObject({ role: 'headline', style: { direction: 'ltr' } });
    const body = ops.find((op): op is Extract<StudioOperation, {op: 'addText'}> => op.op === 'addText' && op.nodeId === `${brand}_copy_en`);
    expect(body).toMatchObject({ role: 'body', style: { direction: 'ltr' } });
    expect(() => renderOperationsToSvg(ops, width, height)).not.toThrow();
  });

  it('draws both languages when both were sent', () => {
    const ops = build({ ...KURDISH, ...ENGLISH });
    expect(texts(ops)).toEqual([KURDISH.headlineCkb, ENGLISH.headlineEn, KURDISH.copyCkb, ENGLISH.copyEn]);
    expect(() => renderOperationsToSvg(ops, width, height)).not.toThrow();
  });

  it('leaves out the badge, offer, contact line and their frames when none were sent', () => {
    const ops = build({ ...KURDISH, headlineEn: '  ', copyEn: '' });
    const ids = ops.flatMap(op => 'nodeId' in op ? [op.nodeId] : []);
    for (const slot of ['authority_badge', 'discount_display', 'contact_info', 'footer_bg', 'headline_en', 'copy_en']) {
      expect(ids).not.toContain(`${brand}_${slot}`);
    }
  });

  it('draws the badge, offer and contact line the client did send', () => {
    const extras = { badgeText: 'Client badge', discountText: 'Client offer', contactText: 'client.example' };
    const ops = build({ ...KURDISH, ...extras });
    expect(texts(ops)).toEqual([extras.badgeText, KURDISH.headlineCkb, extras.discountText, KURDISH.copyCkb, extras.contactText]);
    expect(() => renderOperationsToSvg(ops, width, height)).not.toThrow();
  });

  it('draws no card when there is no body or offer to put in it', () => {
    const ops = build({ headlineCkb: KURDISH.headlineCkb });
    expect(texts(ops)).toEqual([KURDISH.headlineCkb]);
    expect(ops.flatMap(op => 'nodeId' in op ? [op.nodeId] : []).some((id) => /card/.test(id))).toBe(false);
  });

  it('carries no service claims in its vector shapes, and its SVG is valid XML', () => {
    const svg = vectorSources(build({ ...KURDISH, ...ENGLISH, contactText: 'client.example' })).join('\n');
    expect(svg).not.toMatch(/Genuine|Pharmacists|Delivery|GMP|ڕەسەن|پزیشکی|گەیاندن/);
    // A bare ampersand outside a comment made the Drustee preview fail to render at all.
    expect(svg.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
  });
});
