import { describe, it, expect } from 'vitest';
import {
  createKaaeEligibilityDecreeTemplate,
  createKaaeGlobalMilestoneTemplate,
  createKaaeEvaluatorCallTemplate,
  createKaaeMetricsReportTemplate,
} from '../src/templates/kaae-institutional.template.js';
import { DesignRouter } from '../src/design-router.js';
import { KaaeGraphicsLearningEngine } from '../src/kaae-graphics-learning.js';
import type { DesignBrief } from '@hawa/domain';

describe('KAAE Institutional Procedural Templates & Intelligent Routing', () => {
  const engine = new KaaeGraphicsLearningEngine();
  const router = new DesignRouter();

  it('1. generates valid StudioOperation vector AST for AUK Eligibility Decree', () => {
    const ops = createKaaeEligibilityDecreeTemplate({
      pageId: 'auk_decree_test',
      institutionNameEn: 'American University of Kurdistan (AUK)',
      institutionNameCkb: 'زانکۆی ئەمریکی لە کوردستان (AUK)',
      collegialAdvicesCount: 13,
      recommendationsCount: 0,
      requirementsCount: 0,
    });

    expect(ops.length).toBeGreaterThan(10);
    const bgOp = ops.find((o) => o.op === 'addVector') as any;
    expect(bgOp).toBeDefined();
    expect(bgOp?.source).toContain('#002050');

    // Verify statutory citation and advice numbers
    const lawNode = ops.find((o) => o.op === 'addText' && (o as any).text.includes('LAW NO. 6 OF 2022'));
    expect(lawNode).toBeDefined();

    const adviceNode = ops.find((o) => o.op === 'addText' && (o as any).text.includes('Collegial Advices: 13'));
    expect(adviceNode).toBeDefined();
  });

  it('2. generates valid StudioOperation vector AST for Global Milestone (INQAAHE)', () => {
    const ops = createKaaeGlobalMilestoneTemplate({
      pageId: 'inqaahe_milestone_test',
      milestoneTitleEn: 'Approved for Associate Membership',
      milestoneTitleCkb: 'پەسەندکرا بۆ ئەندامێتی هاوبەش',
      networkNameEn: 'INQAAHE',
      networkNameCkb: 'تۆڕی نێودەوڵەتی بۆ دەزگاکانی دڵنیایی جۆری لە خوێندنی باڵا',
    });

    expect(ops.length).toBeGreaterThan(8);
    const bgOp = ops.find((o) => o.op === 'addVector') as any;
    expect(bgOp).toBeDefined();
    expect(bgOp?.source).toContain('#160874');

    const networkNode = ops.find((o) => o.op === 'addText' && (o as any).text === 'INQAAHE') as any;
    expect(networkNode).toBeDefined();
    expect(networkNode.style?.color).toBe('#E8B85C');
  });

  it('3. generates valid StudioOperation vector AST for Call for Peer Evaluators', () => {
    const ops = createKaaeEvaluatorCallTemplate({
      pageId: 'evaluator_call_test',
      cheEvaluatorTarget: 30,
      k12EvaluatorTarget: 30,
    });

    expect(ops.length).toBeGreaterThan(12);
    const cheVal = ops.find((o) => o.op === 'addText' && (o as any).text === '30');
    expect(cheVal).toBeDefined();

    const headline = ops.find((o) => o.op === 'addText' && (o as any).text === 'CALL FOR PEER EVALUATORS');
    expect(headline).toBeDefined();
  });

  it('4. generates valid StudioOperation vector AST for OTA Metrics & Reach Card', () => {
    const ops = createKaaeMetricsReportTemplate({
      pageId: 'metrics_report_test',
      socialViews: '4.24M',
      socialReach: '1.09M',
      volunteerCount: 138,
      pilotSchoolsCount: 12,
      pilotUniversitiesCount: 11,
    });

    expect(ops.length).toBeGreaterThan(15);
    const viewsNode = ops.find((o) => o.op === 'addText' && (o as any).text === '4.24M') as any;
    expect(viewsNode).toBeDefined();
    expect(viewsNode.style?.color).toBe('#E8B85C');

    const volNode = ops.find((o) => o.op === 'addText' && (o as any).text === '138');
    expect(volNode).toBeDefined();
  });

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
      readyForFigma: true,
      qualityScore: 1.0,
      validationWarnings: [],
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
