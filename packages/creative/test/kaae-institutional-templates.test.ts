import { describe, it, expect } from 'vitest';
import { DesignRouter } from '../src/design-router.js';
import { KaaeGraphicsLearningEngine } from '../src/kaae-graphics-learning.js';
import type { DesignBrief } from '@hawa/domain';

describe('KAAE institutional routing and graphics knowledge', () => {
  const engine = new KaaeGraphicsLearningEngine();
  const router = new DesignRouter();

  it('5. auto-routes KAAE institutional prompts to the appropriate templates with high confidence', () => {
    const eligibilityBrief: DesignBrief = {
      briefId: 'brief_eligibility',
      taskId: 'task_1',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      clientDnaVersion: 5,
      objective: 'Issue official decree conferring Eligibility Status to Catholic University in Erbil (CUE)',
      taskRoute: 'template_fill',
      variants: [{ id: 'v1', name: 'feed', width: 1080, height: 1350, aspectRatio: '4:5', role: 'custom' }],
      exactCopy: [{ id: 'c1', role: 'headline', text: 'CUE Eligibility Status Granted', language: 'en', direction: 'ltr', approved: true, protectedTokens: [] }],
      missingFacts: [],
      primaryLanguage: 'en', direction: 'ltr', requiredAssetRoles: ['logo_primary'], createdAt: '2026-09-27T00:00:00Z',
    };

    const resolution1 = router.resolveRoute(eligibilityBrief, []);
    expect(resolution1.route).toBe('template_fill');
    expect(resolution1.matchedTemplateId).toBe('kaae_eligibility_decree');
    expect(resolution1.confidence).toBeGreaterThanOrEqual(0.95);

    const milestoneBrief: DesignBrief = {
      ...eligibilityBrief,
      briefId: 'brief_milestone',
      objective: 'Announce CHEA CIQG new global milestone membership',
      exactCopy: [{ id: 'c2', role: 'headline', text: 'CHEA CIQG Approved', language: 'en', direction: 'ltr', approved: true, protectedTokens: [] }],
    };

    const resolution2 = router.resolveRoute(milestoneBrief, []);
    expect(resolution2.matchedTemplateId).toBe('kaae_global_milestone');
    expect(resolution2.confidence).toBeGreaterThanOrEqual(0.95);

    const evaluatorBrief: DesignBrief = {
      ...eligibilityBrief,
      briefId: 'brief_evaluator',
      objective: 'Launch national call for peer evaluators across higher education and K-12',
      exactCopy: [{ id: 'c3', role: 'headline', text: 'Join KAAE as Peer Reviewer', language: 'en', direction: 'ltr', approved: true, protectedTokens: [] }],
    };

    const resolution3 = router.resolveRoute(evaluatorBrief, []);
    expect(resolution3.matchedTemplateId).toBe('kaae_evaluator_call');
    expect(resolution3.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('6. KaaeGraphicsLearningEngine queries institutional SWOT, ALOs, archetypes, and synthesizes Kurdish copy', () => {
    const swot = engine.getSwotAnalysis();
    expect(swot.strengths.length).toBeGreaterThanOrEqual(1);
    expect(swot.weaknesses.length).toBeGreaterThanOrEqual(1);
    expect(swot.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(swot.threats.length).toBeGreaterThanOrEqual(1);

    const alos = engine.getAloNetwork();
    expect(alos.length).toBeGreaterThanOrEqual(5);
    expect(alos.some((a) => a.name.includes('Faraj') || a.institution.includes('HMU'))).toBe(true);

    const archetypes = engine.getFifteenGraphicArchetypes();
    expect(archetypes.length).toBeGreaterThanOrEqual(4);

    const copyDecree = engine.synthesizeKurdishInstitutionalCopy('AUK eligibility decree');
    expect(copyDecree).toContain('پێدانی پێگەی شیاوبوون');

    const copyMilestone = engine.synthesizeKurdishInstitutionalCopy('CHEA CIQG international milestone');
    expect(copyMilestone).toContain('تۆڕە جیهانییەکان');

    const copyEvaluator = engine.synthesizeKurdishInstitutionalCopy('Call for Peer Reviewers');
    expect(copyEvaluator).toContain('هەڵسەنگێنەرانی هاوتا');
  });
});
