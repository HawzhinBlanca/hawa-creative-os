import { describe, it, expect } from 'vitest';
import { isStandingRule, parseRulesCommand, formatRulesList, formatRuleSaved } from '../src/services/standing-rules-chat.js';
import { normalizeGuidelines, fontCaveat, readBrandGuidelines } from '../src/services/brand-guidelines.js';

describe('standing rules said in chat', () => {
  it('is a time word with an instruction verb, in English or Sorani', () => {
    expect(isStandingRule('From now on, put the logo bottom-right')).toBe(true);
    expect(isStandingRule('Always use Noto Naskh Arabic for Kurdish titles')).toBe(true);
    expect(isStandingRule('Never use red on KAAE designs')).toBe(true);
    expect(isStandingRule('لەمەودوا لۆگۆکە لە خوارەوە دابنێ')).toBe(true);
    expect(isStandingRule('هەمیشە ڕەنگی زەرد بەکاربهێنە بۆ ناونیشان')).toBe(true);
  });

  it('is not a complaint about this design, nor a one-off change', () => {
    expect(isStandingRule('the logo always looks cramped')).toBe(false);
    expect(isStandingRule('the logo never looks right')).toBe(false);
    expect(isStandingRule('put the logo bottom-right')).toBe(false);
    expect(isStandingRule('MEET KAAE AT SAGACON 2026')).toBe(false);
  });

  it('reads /rules and /forget with their numbers', () => {
    expect(parseRulesCommand('/rules')).toEqual({ kind: 'list' });
    expect(parseRulesCommand('/rules@HawaBot')).toEqual({ kind: 'list' });
    expect(parseRulesCommand('/forget 2')).toEqual({ kind: 'forget', numbers: [2] });
    expect(parseRulesCommand('/forget 2, 5 2')).toEqual({ kind: 'forget', numbers: [2, 5] });
    expect(parseRulesCommand('/forget')).toEqual({ kind: 'forget_usage' });
    expect(parseRulesCommand('/forget all of them')).toEqual({ kind: 'forget_usage' });
    expect(parseRulesCommand('/rulesx')).toBeNull();
    expect(parseRulesCommand('rules')).toBeNull();
  });

  it('lists rules numbered, escaped for Telegram HTML', () => {
    const rules = [
      { id: 'a', clientId: 'c', humanRule: 'Put the logo bottom-right', category: 'logo', machineRule: {}, createdAt: new Date() },
      { id: 'b', clientId: 'c', humanRule: 'Titles <gold> & white', category: 'colour', machineRule: {}, createdAt: new Date() },
    ];
    const text = formatRulesList('KAAE', rules);
    expect(text).toContain('1. Put the logo bottom-right');
    expect(text).toContain('2. Titles &lt;gold&gt; &amp; white');
    expect(formatRulesList('KAAE', [])).toContain('No standing rules for KAAE yet');
    expect(formatRuleSaved('KAAE', 'x', true, 1)).toContain('1 rule in force');
    expect(formatRuleSaved('KAAE', 'x', false, 3)).toContain('Already a standing rule');
  });
});

describe('brand guidelines', () => {
  it('keeps only real rules, with valid hex codes, and nothing for a document that is not guidelines', () => {
    const read = normalizeGuidelines({
      isBrandGuidelines: true,
      brandName: 'KAAE',
      summary: 'Brand guidelines.',
      rules: [
        { category: 'colour', rule: 'Use  Kurdistan Sun Gold for accents', fontFamily: '', script: 'any', colourHex: '#f7b500' },
        { category: 'bogus' as any, rule: 'Keep clear space', fontFamily: '', script: 'weird' as any, colourHex: 'gold' },
        { category: 'logo', rule: '   ', fontFamily: '', script: 'any', colourHex: '' },
      ],
    });
    expect(read.rules).toHaveLength(2);
    expect(read.rules[0]).toMatchObject({ rule: 'Use Kurdistan Sun Gold for accents', colourHex: '#F7B500' });
    expect(read.rules[1]).toMatchObject({ category: 'general', script: 'any', colourHex: '' });
    expect(normalizeGuidelines({ isBrandGuidelines: false, rules: read.rules } as any).rules).toEqual([]);
  });

  it('says beside a rule when the studio cannot draw the font it names', () => {
    expect(fontCaveat({ category: 'typography', rule: 'Kurdish in Noto Sans Arabic', fontFamily: 'Noto Sans Arabic', script: 'arabic', colourHex: '' })).toBeUndefined();
    expect(fontCaveat({ category: 'typography', rule: 'Kurdish in Rabar', fontFamily: 'Rabar_022', script: 'arabic', colourHex: '' })).toMatch(/not installed/);
    expect(fontCaveat({ category: 'typography', rule: 'Kurdish in Verdana', fontFamily: 'Verdana', script: 'arabic', colourHex: '' })).toMatch(/cannot draw Kurdish/);
  });

  it('sends the PDF to the model as a file and reads its answer', async () => {
    const calls: any[] = [];
    const model = {
      completeJson: async (params: any) => {
        calls.push(params);
        return { data: { isBrandGuidelines: true, brandName: 'KAAE', summary: 's', rules: [{ category: 'logo', rule: 'Logo bottom-right', fontFamily: '', script: 'any', colourHex: '' }] } };
      },
    };
    const read = await readBrandGuidelines(model as any, { pdf: { filename: 'guide.pdf', bytes: Buffer.from('%PDF-1.7 x') }, senderNote: 'new guidelines' });
    expect(read.rules[0].rule).toBe('Logo bottom-right');
    expect(calls[0].files[0]).toMatchObject({ filename: 'guide.pdf', mediaType: 'application/pdf' });
    expect(calls[0].prompt).toContain('new guidelines');
  });
});
