import { describe, it, expect } from 'vitest';
import { checkNodeCollisions } from '../src/layout-bounds.js';
import { detectUnsolicitedContent } from '../src/copy-validator.js';

describe('Deterministic QA: Collision & Unsolicited Content Detection', () => {
  it('detects foreground node collisions with precise overlap area', () => {
    // Two overlapping text nodes
    const collidingNodes = [
      { id: 'txt_headline', x: 100, y: 100, width: 300, height: 50, role: 'headline', text: 'Official Launch' },
      { id: 'txt_subhead', x: 200, y: 120, width: 300, height: 40, role: 'body', text: 'Supporting details' },
    ];

    const violations = checkNodeCollisions(collidingNodes);
    expect(violations).toHaveLength(1);
    expect(violations[0].nodeIdA).toBe('txt_headline');
    expect(violations[0].nodeIdB).toBe('txt_subhead');
    expect(violations[0].intersectionAreaPx).toBeGreaterThan(0);
  });

  it('allows non-overlapping nodes to pass cleanly', () => {
    const cleanNodes = [
      { id: 'txt_title', x: 100, y: 100, width: 300, height: 50, role: 'headline', text: 'Title' },
      { id: 'txt_body', x: 100, y: 180, width: 300, height: 50, role: 'body', text: 'Body paragraph' },
    ];

    const violations = checkNodeCollisions(cleanNodes);
    expect(violations).toHaveLength(0);
  });

  it('ignores background containers holding child nodes', () => {
    // Card container holding child text
    const containerAndChild = [
      { id: 'bg_card', x: 50, y: 50, width: 400, height: 200, role: 'background' },
      { id: 'txt_inside', x: 70, y: 70, width: 200, height: 30, role: 'body', text: 'Card text' },
    ];

    const violations = checkNodeCollisions(containerAndChild);
    expect(violations).toHaveLength(0);
  });

  it('detects unapproved statutory boilerplate or prohibited copy injections', () => {
    const contaminatedDoc = [
      'Welcome to the official launch',
      'Kurdistan Regional Parliament Law No. 6 · Official Release',
    ];

    const findings = detectUnsolicitedContent(contaminatedDoc, []);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('UNSOLICITED_CONTENT_DETECTED');
    expect(findings[0].evidence?.offendingText).toContain('Parliament Law No. 6');
  });

  it('passes clean approved copy without false positives', () => {
    const cleanDoc = [
      'His Excellency Prime Minister Masrour Barzani',
      'Saturday, October 18, 2026',
    ];

    const findings = detectUnsolicitedContent(cleanDoc, cleanDoc.map(text => ({ id: text, role: 'body', text, language: 'en', direction: 'ltr', approved: true, protectedTokens: [] })));
    expect(findings).toHaveLength(0);
  });
});
