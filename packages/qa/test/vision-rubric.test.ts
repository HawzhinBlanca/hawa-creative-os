import { describe, it, expect } from 'vitest';
import {
  evaluateVisionRubric,
  type QualityEvaluationCandidate,
} from '../src/vision-rubric.js';

describe('Multilingual Visual QA Vision Rubric Scorer (FR-039, Invariant #9, Gate E)', () => {
  it('awards AAA grade when design satisfies all copy, Kurdish diacritic, contrast, and safe-zone criteria', () => {
    const candidate: QualityEvaluationCandidate = {
      taskId: 'task-eval-1',
      revisionId: 'rev-001',
      clientId: 'client-drustee',
      format: 'feed',
      dimensions: { width: 1080, height: 1350 },
      approvedCopy: {
        headlineCkb: 'کەمپینی نوێی دروستی',
        prices: ['۲۵,۰۰۰ د.ع'],
        phones: ['+9647501234567'],
      },
      nodes: [
        {
          id: 'bg',
          role: 'background',
          x: 0,
          y: 0,
          width: 1080,
          height: 1350,
          background: '#0B192C',
        },
        {
          id: 'headline',
          role: 'headline',
          text: 'کەمپینی نوێی دروستی',
          x: 72,
          y: 180,
          width: 936,
          height: 90,
          color: '#F8FAFC',
          background: '#0B192C',
          fontSize: 32,
          lineHeight: 1.55,
        },
        {
          id: 'copy',
          role: 'copy',
          text: 'نرخی تایبەت تەنها ۲۵,۰۰۰ د.ع پەیوەندی بکە بە +9647501234567',
          x: 72,
          y: 400,
          width: 936,
          height: 60,
          color: '#34D399',
          background: '#0B192C',
          fontSize: 20,
          lineHeight: 1.52,
        },
      ],
    };

    const report = evaluateVisionRubric(candidate);
    expect(report.passed).toBe(true);
    expect(report.grade).toBe('AAA');
    expect(report.overallScore).toBeGreaterThanOrEqual(95);
    expect(report.hardFailures).toHaveLength(0);
    expect(report.cryptographicSeal).toBeDefined();
    expect(report.cryptographicSeal).toHaveLength(64);
  });

  it('enforces Invariant #9: missing approved price triggers hard failure regardless of score', () => {
    const candidate: QualityEvaluationCandidate = {
      taskId: 'task-eval-missing-price',
      revisionId: 'rev-002',
      clientId: 'client-drustee',
      format: 'feed',
      dimensions: { width: 1080, height: 1350 },
      approvedCopy: {
        prices: ['۴۵,۰۰۰ د.ع'], // Approved price missing from rendered text
      },
      nodes: [
        {
          id: 'headline',
          role: 'headline',
          text: 'ئۆفەری بەهێز بۆ هەمووان',
          x: 72,
          y: 200,
          width: 936,
          height: 80,
          color: '#FFFFFF',
          background: '#000000',
          fontSize: 28,
          lineHeight: 1.5,
        },
      ],
    };

    const report = evaluateVisionRubric(candidate);
    expect(report.passed).toBe(false);
    expect(report.hardFailures.length).toBeGreaterThan(0);
    expect(report.hardFailures[0]).toContain('۴۵,۰۰۰ د.ع');
    expect(report.grade).not.toBe('AAA');
  });

  it('detects low Kurdish line-height as vertical diacritic clipping hazard', () => {
    const candidate: QualityEvaluationCandidate = {
      taskId: 'task-eval-diacritics',
      revisionId: 'rev-003',
      clientId: 'client-drustee',
      format: 'square',
      dimensions: { width: 1080, height: 1080 },
      nodes: [
        {
          id: 'kurdish-head',
          role: 'headline',
          text: 'پێشکەشکردنی گوڵ بۆ سلێمانی و دهۆک', // Contains ڵ, ۆ, ێ
          x: 50,
          y: 200,
          width: 900,
          height: 60,
          lineHeight: 1.15, // Dangerously low line-height!
          color: '#FFFFFF',
          background: '#1E293B',
        },
      ],
    };

    const report = evaluateVisionRubric(candidate);
    const diacriticFinding = report.findings.find((f) => f.category === 'typography' && f.message.includes('diacritics'));
    expect(diacriticFinding).toBeDefined();
    expect(report.criteriaScores.kurdishTypography).toBeLessThan(25);
  });

  it('flags nodes overlapping Instagram Story 9:16 safe-zone danger boundaries', () => {
    const candidate: QualityEvaluationCandidate = {
      taskId: 'task-eval-story-danger',
      revisionId: 'rev-004',
      clientId: 'client-drustee',
      format: 'story',
      dimensions: { width: 1080, height: 1920 },
      nodes: [
        {
          id: 'top-violator',
          role: 'headline',
          text: 'Story Top Title',
          x: 50,
          y: 80, // Overlaps top 240px danger area!
          width: 900,
          height: 80,
        },
        {
          id: 'bottom-violator',
          role: 'copy',
          text: 'Click here to shop now',
          x: 50,
          y: 1750, // Overlaps bottom 320px danger area! (1920 - 320 = 1600)
          width: 900,
          height: 100,
        },
      ],
    };

    const report = evaluateVisionRubric(candidate);
    const safeZoneFindings = report.findings.filter((f) => f.category === 'safe_zone');
    expect(safeZoneFindings.length).toBeGreaterThanOrEqual(2);
    expect(report.criteriaScores.layoutSafeZones).toBeLessThan(20);
  });
});
