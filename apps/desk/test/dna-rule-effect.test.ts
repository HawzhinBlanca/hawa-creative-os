import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ruleEffectBadge } from '../src/screens/DnaScreen';

/**
 * ADR-291: the DNA screen's rule list said "Hard QA Invariant" on every layout rule. No layout rule is
 * checked by QA: a model reads it, or (for a client designed from its packaged reference) nothing
 * does. The pill now says what Core reports for that rule.
 */
describe('ADR-291: the DNA rule list says what each rule does to a design', () => {
  const effect = {
    clientId: 'c1', reference: 'packaged',
    rules: [
      { source: 'standing_rule', text: 'Logo top right', status: 'prompt_only', note: 'standing' },
      { source: 'dna_layout_rule', text: 'Old pack rule', status: 'dropped', note: 'Not read: packaged reference.' },
      { source: 'learned_rule', text: 'Promoted rule', status: 'prompt_only', note: 'Only a model reads it.' },
      { source: 'dna_brand_value', kind: 'palette', text: '#FFFFFF #000000', status: 'applied_deterministically', note: 'snapped' },
    ],
  };

  it('names a dropped rule as unused, a promoted one as read by models, with Core\'s reason', () => {
    expect(ruleEffectBadge(effect, 'Old pack rule')).toEqual({ label: 'Not used in designs', tone: 'bad', note: 'Not read: packaged reference.' });
    expect(ruleEffectBadge(effect, 'Promoted rule')).toEqual({ label: 'Read by the models only', tone: 'warn', note: 'Only a model reads it.' });
  });

  it('claims nothing when Core did not report the rule, or did not answer', () => {
    expect(ruleEffectBadge(effect, 'Logo top right').label).toBe('Effect not read');
    expect(ruleEffectBadge(null, 'Old pack rule')).toMatchObject({ label: 'Effect not read', tone: 'blue' });
  });

  it('no longer labels any rule a hard QA invariant', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/DnaScreen.tsx'), 'utf8');
    expect(source).not.toContain('Hard QA Invariant');
  });
});
