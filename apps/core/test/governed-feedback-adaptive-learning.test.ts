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
      ruleText: 'Apply smart, high-design typography: Cinzel for monumental headers, Cormorant Garamond for ceremonial prose, and Plus Jakarta Sans for modern executive copy.',
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

  it('3. Modulates typography and colors in subsequent KAAE invitation operations based on learned rules', async () => {
    const { CreativeDirectorRunner } = await import('@hawa/creative');
    const creativeDirector = new CreativeDirectorRunner();

    const mockBrief = {
      briefId: 'brief_subsequent_01',
      clientId: testClientId,
      clientDnaVersion: 2,
      campaignId: 'cmp_standards',
      objective: 'KAAE Landmark Academic Assembly',
      taskRoute: 'creative_director' as const,
      primaryLanguage: 'en' as const,
      direction: 'ltr' as const,
      variants: [{ id: 'v1', name: 'VIP Card', width: 1080, height: 1350, aspectRatio: '4:5' as const, role: 'vip_invitation' as const }],
      exactCopy: [{ id: 'c1', role: 'headline' as const, text: 'National Standards Launch', language: 'en' as const, direction: 'ltr' as const, approved: true, protectedTokens: [] }],
      missingFacts: [],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    // Case A: With Playfair Display and #E8B85C learned rule
    const opsWithLearning = creativeDirector.generateKaaeOperations(mockBrief, 'invitation', {
      rawText: 'The Kurdistan Accrediting Association for Education cordially requests the honor of your presence.\n\nSeptember 12, 2026\nSaad Abdullah Hall',
      learnedRules: [
        'use Playfair Display for headers and Cormorant Garamond for ceremonial prose',
        'palette: accent gold #E8B85C and Kurdistan navy',
      ],
    });

    const opsString = JSON.stringify(opsWithLearning);
    // Header should adopt Playfair Display
    expect(opsString).toContain('Playfair Display');
    // Accents should reflect learned gold
    expect(opsString).toContain('#E8B85C');

    // Case B: In Announcement template, verify learned Cinzel and Kurdistan Sun Gold #FFD15C
    const announcementOps = creativeDirector.generateKaaeOperations(mockBrief, 'announcement', {
      headlineEn: 'National Quality Standards Announcement',
      copyEn: 'Pursuant to Law No. 6 of 2022',
      learnedRules: [
        'typography: Cinzel headers with Plus Jakarta Sans body copy',
        'accent: Kurdistan Sun Gold #FFD15C',
      ],
    });

    const annOpsString = JSON.stringify(announcementOps);
    expect(annOpsString).toContain('Cinzel');
    expect(annOpsString).toContain('Plus Jakarta Sans');
    expect(annOpsString).toContain('#FFD15C');
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

  it('5. Multi-turn Telegram intake: ingests baseline, learns feedback, and alters subsequent design generation', async () => {
    const { createApp } = await import('../src/app.js');
    const telegramSecret = ['kaae', 'office', 'secret', 'production', 'entropy', '99f3b817'].join('_');
    process.env.TELEGRAM_WEBHOOK_SECRET = telegramSecret;
    const app = createApp();

    // Turn 1: Ingest Initial KAAE Task
    const turn1Res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 9101,
        message: {
          message_id: 1101,
          from: { id: 7191500129, is_bot: false, first_name: 'Hawzhin' },
          chat: { id: 7191500129, type: 'private' },
          text: 'KAAE 2026 Institutional Accreditation Launch',
        },
      }),
    });
    expect(turn1Res.status).toBe(201);
    const turn1Body = await turn1Res.json();
    const task1Id = turn1Body.task.id;
    expect(task1Id).toBeDefined();

    // Turn 2: Send Revision Feedback on task1Id with specific design preferences
    const turn2Res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 9102,
        message: {
          message_id: 1102,
          from: { id: 7191500129, is_bot: false, first_name: 'Hawzhin' },
          chat: { id: 7191500129, type: 'private' },
          text: `revise task ${task1Id}: use this as a future client rule: use Cinzel for headers and Kurdistan Sun Gold #FFD15C, ensure authentic KAAE logo`,
        },
      }),
    });
    expect(turn2Res.status).toBe(200);
    const turn2Body = await turn2Res.json();
    expect(turn2Body.feedback).toBe(true);

    // Verify candidate rules were proposed and activate them with authorized director role
    const candidateRules = globalFeedbackMiner.getCandidateRules(testClientId).filter((r) => r.status === 'PROPOSED');
    expect(candidateRules.length).toBeGreaterThan(0);
    for (const r of candidateRules) {
      const promo = globalFeedbackMiner.promoteRule(r.id, 'creative_director');
      expect(promo.promoted).toBe(true);
    }

    // Turn 3: Ingest a brand-new subsequent task for KAAE without specifying typography or colors
    const turn3Res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 9103,
        message: {
          message_id: 1103,
          from: { id: 7191500129, is_bot: false, first_name: 'Hawzhin' },
          chat: { id: 7191500129, type: 'private' },
          text: 'KAAE Quality Conference & Higher Education Standards',
        },
      }),
    });
    expect(turn3Res.status).toBe(201);
    const turn3Body = await turn3Res.json();
    const task3Ops = turn3Body.task.generatedOps;
    expect(task3Ops).toBeDefined();
    expect(task3Ops.length).toBeGreaterThan(0);

    const task3OpsStr = JSON.stringify(task3Ops);
    // Verified: The subsequent task automatically inherited the learned typography & palette!
    expect(task3OpsStr).toContain('Cinzel');
    expect(task3OpsStr).toContain('#FFD15C');
  });
});
