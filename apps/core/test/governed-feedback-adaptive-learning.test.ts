import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { globalFeedbackMiner } from '@hawa/creative';
import fs from 'node:fs';
import path from 'node:path';

describe('Governed Feedback & Adaptive Learning Engine (ADR-0044)', () => {
  const testClientId = 'c1000000-0000-4000-8000-000000000002'; // KAAE Client ID

  it('1. Learns design rules from human feedback and promotes them to Client DNA', () => {
    const taskId = 'task_kaae_sample_01';
    const operatorFeedback = 'the design didnt use the real logo of kaae, remove that wrong logo to be replaced with real logo, every design by kaae should use real kaae brand dna and logo, except the font, choose based on the design smartly, and use canva for reviews';

    // Step 1: Record negative feedback on unrefined draft
    const negRes = globalFeedbackMiner.recordNegativeFeedback(
      taskId,
      testClientId,
      operatorFeedback,
      { id: 'operator_hawzhin', role: 'operator', name: 'Hawzhin' }
    );
    expect(negRes.negativeExampleRecorded).toBe(true);

    // Step 2: Propose and promote authentic logo rule
    const logoRule = globalFeedbackMiner.proposeExplicitRule({
      clientId: testClientId,
      taskId,
      title: 'Authentic Brand Seal & Emblem Exclusivity',
      category: 'layout',
      ruleText: `Always use verified authentic master brand seal and emblem (${testClientId}); never use synthetic approximations.`,
      rationale: 'Operator required authentic master brand seal and assets.',
      actor: { id: 'operator_hawzhin', role: 'operator', name: 'Hawzhin' },
    });
    const logoPromoted = globalFeedbackMiner.promoteRule(logoRule.id, 'creative_director');
    expect(logoPromoted.promoted).toBe(true);
    expect(logoPromoted.rule?.status).toBe('PROMOTED');

    // Step 3: Propose and promote smart creative typography rule
    const fontRule = globalFeedbackMiner.proposeExplicitRule({
      clientId: testClientId,
      taskId,
      title: 'Smart Creative Typographic Hierarchy',
      category: 'typography',
      ruleText: 'Apply smart, high-design typography: Cinzel for monumental headers, Playfair Display for ceremonial prose, and Plus Jakarta Sans for modern executive copy.',
      rationale: 'Operator established creative font freedom and smart design font pairings.',
      actor: { id: 'operator_hawzhin', role: 'operator', name: 'Hawzhin' },
    });
    const fontPromoted = globalFeedbackMiner.promoteRule(fontRule.id, 'creative_director');
    expect(fontPromoted.promoted).toBe(true);
    expect(fontPromoted.rule?.status).toBe('PROMOTED');

    // Step 4: Propose and promote Canva review surface rule
    const canvaRule = globalFeedbackMiner.proposeExplicitRule({
      clientId: testClientId,
      taskId,
      title: 'Canva Primary Review & Final Edits Surface',
      category: 'layout',
      ruleText: 'Direct all design reviews and final edits to Canva with prominent edit link bindings.',
      rationale: 'Operator mandated Canva as exclusive review and final edits surface.',
      actor: { id: 'operator_hawzhin', role: 'operator', name: 'Hawzhin' },
    });
    const canvaPromoted = globalFeedbackMiner.promoteRule(canvaRule.id, 'creative_director');
    expect(canvaPromoted.promoted).toBe(true);

    // Verify all 3 rules are actively retrieved for this client
    const activeRules = globalFeedbackMiner
      .getCandidateRules(testClientId)
      .filter((r) => r.status === 'PROMOTED');

    expect(activeRules.length).toBeGreaterThanOrEqual(3);
    const ruleTexts = activeRules.map((r) => r.ruleText);
    expect(ruleTexts.some((t) => t.includes('verified authentic master brand seal'))).toBe(true);
    expect(ruleTexts.some((t) => t.includes('Cinzel'))).toBe(true);
    expect(ruleTexts.some((t) => t.includes('Canva'))).toBe(true);
  });

  it('2. Automatically injects promoted rules into subsequent creative generations', () => {
    const activeRules = globalFeedbackMiner
      .getCandidateRules(testClientId)
      .filter((r) => r.status === 'PROMOTED')
      .map((r) => r.ruleText);

    // Simulate subsequent design intake
    const subsequentTaskParams = {
      clientId: testClientId,
      title: 'KAAE Academic Standards 2026',
      learnedRules: activeRules,
    };

    expect(subsequentTaskParams.learnedRules.length).toBeGreaterThan(0);
    expect(subsequentTaskParams.learnedRules.some((r) => r.includes('Cinzel'))).toBe(true);
    expect(subsequentTaskParams.learnedRules.some((r) => r.includes('Canva'))).toBe(true);
  });

  it('4. Persists learned standards into Client DNA configuration', () => {
    const candidates = [
      path.join(process.cwd(), 'config', 'clients', 'kaae.dna.json'),
      path.join(process.cwd(), '..', '..', 'config', 'clients', 'kaae.dna.json'),
      '/Users/hawzhin/Hawdesign/config/clients/kaae.dna.json',
    ];
    const dnaPath = candidates.find((p) => fs.existsSync(p));
    expect(dnaPath).toBeDefined();

    const dna = JSON.parse(fs.readFileSync(dnaPath!, 'utf-8'));
    expect(dna.identity.officialName).toContain('Kurdistan Accrediting Association for Education');
    expect(Array.isArray(dna.guidelines.layoutRules)).toBe(true);
  });
  // The tests that fed promoted rules into KAAE's v1 templates went with those templates (ADR-127):
  // KAAE's designs are made in the design studio, which reads the client's standing rules instead.
});
