import { describe, it, expect } from 'vitest';
import type { DesignBrief } from '@hawa/domain';
import type { StudioOperation } from '@hawa/contracts';
import { CreativeDirectorRunner } from '../src/index.js';

// generateKaaeOperations used to fill missing copy with its own lines, and a certificate with a
// made-up recipient, programme and dates. Core passes every copy key today, which hid them.
const INVENTED = [
  'National Standards for Quality Assurance in Education',
  'ڕاگەیاندنی فەرمی ستانداردەکانی متمانەبەخشین',
  'Official accreditation framework and institutional standards.',
  'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان.',
  'د. ڕێبوار ئەحمەد محەمەد',
  'پرۆگرامی متمانەبەخشی نیشتمانی بۆ خوێندنی باڵا',
  '2025-09-01',
  '2026-06-30',
  '2026-09-06',
];

const director = new CreativeDirectorRunner();
const brief = (primaryLanguage: 'en' | 'ckb', exactCopy: Array<{ role: string; text: string; language: 'en' | 'ckb' }>) =>
  ({ briefId: 'b', taskId: 't', clientId: 'kaae', primaryLanguage, exactCopy, variants: [{ width: 1080, height: 1350 }] }) as unknown as DesignBrief;
const texts = (ops: StudioOperation[]) => ops.flatMap((op) => (op.op === 'addText' ? [op.text] : []));
const expectNothingInvented = (ops: StudioOperation[]) => {
  const all = JSON.stringify(texts(ops));
  for (const invented of INVENTED) expect(all).not.toContain(invented);
};

describe('generateKaaeOperations announcement', () => {
  it('draws no headline or body when neither the caller nor the brief has them', () => {
    for (const language of ['en', 'ckb'] as const) {
      const ops = director.generateKaaeOperations(brief(language, []), 'announcement');
      expect(ops.some((op) => op.op === 'addText' && /^ann_(headline|copy)_/.test(op.nodeId))).toBe(false);
      expectNothingInvented(ops);
    }
  });

  it('takes brief copy only in the language of the slot', () => {
    const ops = director.generateKaaeOperations(
      brief('ckb', [
        { role: 'other', text: 'An English line', language: 'en' },
        { role: 'other', text: 'دێڕی کوردی', language: 'ckb' },
      ]),
      'announcement'
    );
    const headline = ops.find((op) => op.op === 'addText' && op.nodeId === 'ann_headline_ckb');
    expect(headline && headline.op === 'addText' ? headline.text : undefined).toBe('دێڕی کوردی');
    expect(JSON.stringify(texts(ops))).not.toContain('An English line');
  });
});

describe('generateKaaeOperations certificate', () => {
  it('refuses without a recipient and programme instead of inventing them', () => {
    expect(() => director.generateKaaeOperations(brief('ckb', []), 'certificate')).toThrow(/COPY_REQUIRED/);
    expect(() => director.generateKaaeOperations(brief('ckb', []), 'certificate', { recipientName: 'زانکۆی کۆیە' })).toThrow(/COPY_REQUIRED/);
  });

  it('draws the names it is given and no dates it was not given', () => {
    const ops = director.generateKaaeOperations(brief('ckb', []), 'certificate', { recipientName: 'زانکۆی کۆیە', programName: 'کۆلێژی ئەندازیاری' });
    const ids = ops.flatMap(op => 'nodeId' in op ? [op.nodeId] : []);
    expect(ids).not.toContain('cert_dates');
    expect(ids).not.toContain('cert_issue_date');
    expect(texts(ops)).toContain('زانکۆی کۆیە');
    expect(texts(ops).some((t) => t.includes('undefined'))).toBe(false);
    expectNothingInvented(ops);
  });

  it('draws the dates it is given', () => {
    const ops = director.generateKaaeOperations(brief('en', []), 'certificate', {
      recipientName: 'Koya University', programName: 'College of Engineering', startDate: '2026-01-01', endDate: '2026-12-31', issueDate: '2027-01-15',
    });
    expect(texts(ops)).toEqual(expect.arrayContaining(['from 2026-01-01 to 2026-12-31', 'Issued on 2027-01-15']));
  });
});
