import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackMiner, type ArtboardSnapshot } from '../src/feedback-miner.js';

describe('FeedbackMiner: Governed Learning & Continuous Feedback Loop (B-055, B-056, B-057)', () => {
  let miner: FeedbackMiner;

  beforeEach(() => {
    miner = new FeedbackMiner();
  });

  const initialDraft: ArtboardSnapshot = {
    taskId: 'task-d3-001',
    clientId: 'client-drustee',
    layers: [
      {
        id: 'layer-title',
        type: 'text',
        text: 'Drustee Vitamins',
        color: '#111827',
        fontSize: 32,
        lineHeight: 1.2,
        x: 60,
        y: 80,
        width: 400,
        height: 60
      },
      {
        id: 'layer-desc',
        type: 'text',
        text: 'High quality vitamins',
        color: '#374151',
        fontSize: 18,
        lineHeight: 1.3,
        x: 60,
        y: 160,
        width: 380,
        height: 80
      }
    ]
  };

  const refinedArtboard: ArtboardSnapshot = {
    taskId: 'task-d3-001',
    clientId: 'client-drustee',
    layers: [
      {
        id: 'layer-title',
        type: 'text',
        text: 'دروستی - تەندروستی لە پێشینەیە',
        color: '#01585F', // Overridden to Drustee brand teal
        fontSize: 36,
        lineHeight: 1.52, // Overridden to Sorani diacritic clearance
        x: 60,
        y: 120, // Shifted down for Instagram safe zone
        width: 400,
        height: 70
      },
      {
        id: 'layer-desc',
        type: 'text',
        text: 'ڤیتامین D3+K2 بە بەرزترین کوالێتی',
        color: '#01585F',
        fontSize: 18,
        lineHeight: 1.52,
        x: 60,
        y: 200,
        width: 380,
        height: 80
      }
    ]
  };

  it('accurately identifies visual and copy deltas between draft and final artboard', () => {
    const deltas = miner.diffArtboards(initialDraft, refinedArtboard);

    expect(deltas.length).toBeGreaterThanOrEqual(4);

    const categories = deltas.map((d) => d.category);
    expect(categories).toContain('copy_token');
    expect(categories).toContain('palette');
    expect(categories).toContain('typography');
    expect(categories).toContain('layout');

    const colorDelta = deltas.find((d) => d.category === 'palette');
    expect(colorDelta?.afterValue).toBe('#01585F');

    const lhDelta = deltas.find((d) => d.property === 'lineHeight');
    expect(lhDelta?.afterValue).toBe(1.52);
  });

  it('synthesizes candidate rules with cryptographic SHA-256 evidence digests', () => {
    const proposals = miner.ingestTaskRefinements('client-drustee', 'task-d3-001', initialDraft, refinedArtboard);

    expect(proposals.length).toBeGreaterThan(0);

    const typographyRule = proposals.find((p) => p.category === 'typography');
    expect(typographyRule).toBeDefined();
    expect(typographyRule?.ruleText).toContain('1.52');
    expect(typographyRule?.status).toBe('PROPOSED');
    expect(typographyRule?.sha256Digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('clusters recurring refinements across multiple tasks and increments confidence', () => {
    // Ingest task 1
    miner.ingestTaskRefinements('client-drustee', 'task-d3-001', initialDraft, refinedArtboard);

    // Ingest task 2 with the same brand color override
    const task2Draft: ArtboardSnapshot = {
      taskId: 'task-d3-002',
      clientId: 'client-drustee',
      layers: [{ id: 'header', type: 'text', color: '#000000', x: 0, y: 0, width: 100, height: 50 }]
    };
    const task2Refined: ArtboardSnapshot = {
      taskId: 'task-d3-002',
      clientId: 'client-drustee',
      layers: [{ id: 'header', type: 'text', color: '#01585F', x: 0, y: 0, width: 100, height: 50 }]
    };

    miner.ingestTaskRefinements('client-drustee', 'task-d3-002', task2Draft, task2Refined);

    const rules = miner.getCandidateRules('client-drustee');
    const colorRule = rules.find((r) => r.category === 'palette' && r.ruleText.includes('#01585F'));

    expect(colorRule).toBeDefined();
    expect(colorRule?.frequency).toBeGreaterThanOrEqual(2);
    expect(colorRule?.evidenceTaskIds).toHaveLength(2);
    expect(colorRule?.evidenceTaskIds).toContain('task-d3-001');
    expect(colorRule?.evidenceTaskIds).toContain('task-d3-002');
    expect(colorRule?.confidence).toBeGreaterThan(0.65);
  });

  it('supports human role-authorized promotion to active Client DNA', () => {
    miner.ingestTaskRefinements('client-drustee', 'task-d3-001', initialDraft, refinedArtboard);

    const candidate = miner.getCandidateRules('client-drustee')[0];
    expect(candidate.status).toBe('PROPOSED');

    const result = miner.promoteRule(candidate.id, 'creative_director');
    expect(result.promoted).toBe(true);
    expect(result.rule?.status).toBe('PROMOTED');
    expect(result.rule?.promotedByRole).toBe('creative_director');
    expect(result.auditHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows dismissing candidate rules that are one-off or not reusable', () => {
    miner.ingestTaskRefinements('client-drustee', 'task-d3-001', initialDraft, refinedArtboard);

    const candidate = miner.getCandidateRules('client-drustee')[0];
    const dismissed = miner.dismissRule(candidate.id);
    expect(dismissed).toBe(true);
    expect(candidate.status).toBe('DISMISSED');
  });

  describe('Design Studio Feedback Table Reader (T14, ADR-029)', () => {
    it('ingests approve verdict with notes into a PROPOSED candidate rule', () => {
      const proposals = miner.ingestDesignFeedback({
        id: 'fb-001',
        taskId: 'task-studio-101',
        clientId: 'client-kaae',
        actorId: 'actor-director-1',
        actorRole: 'art_director',
        source: 'desk',
        verdict: 'approve',
        rating: 9,
        notes: 'Ensure deep navy background with gold accents for presidential statements',
      });

      expect(proposals).toHaveLength(1);
      const rule = proposals[0];
      expect(rule.status).toBe('PROPOSED');
      expect(rule.category).toBe('palette');
      expect(rule.ruleText).toContain('deep navy background');
      expect(rule.provenance.taskId).toBe('task-studio-101');
      expect(rule.examples.positiveExampleTaskIds).toContain('task-studio-101');
      expect(rule.examples.negativeExampleTaskIds).toHaveLength(0);
    });

    it('ingests reject verdict and ensures rejected design is never positive evidence', () => {
      // First reject the task
      miner.ingestDesignFeedback({
        id: 'fb-002',
        taskId: 'task-bad-001',
        clientId: 'client-kaae',
        actorId: 'actor-director-1',
        source: 'desk',
        verdict: 'reject',
        rating: 3,
        notes: 'Font size too small and unreadable on mobile screens',
      });

      expect(miner.isTaskRejected('task-bad-001')).toBe(true);

      const rules = miner.getCandidateRules('client-kaae');
      const typoRule = rules.find((r) => r.category === 'typography');
      expect(typoRule).toBeDefined();
      expect(typoRule?.examples.negativeExampleTaskIds).toContain('task-bad-001');
      expect(typoRule?.examples.positiveExampleTaskIds).not.toContain('task-bad-001');

      // Subsequent approve on same task must not mark it as positive
      miner.ingestDesignFeedback({
        id: 'fb-003',
        taskId: 'task-bad-001',
        clientId: 'client-kaae',
        actorId: 'actor-director-1',
        source: 'desk',
        verdict: 'approve',
        rating: 8,
      });

      expect(typoRule?.examples.positiveExampleTaskIds).not.toContain('task-bad-001');
    });

    it('ingests revise verdict notes and categorizes layout guidance', () => {
      const proposals = miner.ingestDesignFeedback({
        id: 'fb-004',
        taskId: 'task-studio-102',
        clientId: 'client-kaae',
        actorId: 'actor-director-2',
        source: 'desk',
        verdict: 'revise',
        notes: 'Maintain at least 48px margin clearance around the seal',
      });

      expect(proposals).toHaveLength(1);
      expect(proposals[0].category).toBe('layout');
      expect(proposals[0].status).toBe('PROPOSED');
    });

    it('detects conflicts when proposed rule contradicts existing promoted rules', () => {
      // Establish existing rule
      miner.proposeExplicitRule({
        clientId: 'client-kaae',
        taskId: 'task-prior-001',
        title: 'Top Alignment Rule',
        category: 'layout',
        ruleText: 'Always align the title to the top right of the canvas',
        rationale: 'KAAE institutional standard',
        actor: { id: 'dir-1', role: 'creative_director' },
      });
      const firstRule = miner.getCandidateRules('client-kaae')[0];
      miner.promoteRule(firstRule.id, 'creative_director');

      // Ingest conflicting feedback
      const proposals = miner.ingestDesignFeedback({
        id: 'fb-005',
        taskId: 'task-studio-103',
        clientId: 'client-kaae',
        actorId: 'actor-director-1',
        source: 'desk',
        verdict: 'revise',
        notes: 'Always align the title to the bottom left',
      });

      expect(proposals).toHaveLength(1);
      expect(proposals[0].conflicts.length).toBeGreaterThan(0);
      expect(proposals[0].conflicts[0]).toContain('conflicts with existing rule');

      // Conflicting rule cannot be promoted
      const promoResult = miner.promoteRule(proposals[0].id, 'creative_director');
      expect(promoResult.promoted).toBe(false);
      expect(promoResult.reason).toBe('CONFLICTING_RULES_PENDING');
    });
  });
});
