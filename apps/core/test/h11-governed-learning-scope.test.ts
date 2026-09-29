import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { globalFeedbackMiner } from '@hawa/creative';
import fs from 'node:fs';
import path from 'node:path';

describe('H11 — Governed Learning with Scope, Authority & Rollback', () => {
  const KAAE_CLIENT_ID = 'c1000000-0000-4000-8000-000000000002';
  const OTHER_CLIENT_ID = 'c2000000-0000-4000-8000-000000000003';
  const operatorToken = 'test_operator_token_h11';
  const artDirectorToken = 'test_art_director_bearer';
  const initialEnv = { ...process.env };

  beforeEach(() => {
    process.env.HAWA_BEARER_TOKEN = operatorToken;
    process.env.HAWA_ART_DIRECTOR_KEY = artDirectorToken;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = initialEnv;
  });

  // Cases 1 ("revise task" feedback) and 5 (a reply quoting an unknown task id) sent their messages to
  // the Telegram webhook, removed by stage 2 of ADR-135 with the old intake's feedback and reply
  // readers. The lifecycle path's replies, an unknown one included: lifecycle-internal-intake.test.ts.
  it('2. Another client\'s feedback cannot change KAAE DNA, rules or files', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

    // Record initial KAAE DNA file hash
    const kaaeDnaPath = path.join(process.cwd(), 'config', 'clients', 'kaae.dna.json');
    const initialKaaeDna = fs.existsSync(kaaeDnaPath) ? fs.readFileSync(kaaeDnaPath, 'utf-8') : null;

    // Create a task scoped to OTHER_CLIENT_ID
    const taskRes = await app.request('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        title: 'Other Client Campaign',
        clientId: OTHER_CLIENT_ID,
      }),
    });
    expect(taskRes.status).toBe(201);
    const otherTask = await taskRes.json();

    // Send feedback on OTHER_CLIENT_ID task via explicit rule proposal
    const propRes = await app.request(`/clients/${OTHER_CLIENT_ID}/candidate-rules/propose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        taskId: otherTask.id,
        title: 'Client B Coral Theme',
        category: 'palette',
        ruleText: 'Always use Coral #FF6F61 for Client B hero cards',
        rationale: 'Client B brand identity guidelines',
      }),
    });
    expect(propRes.status).toBe(201);
    const { proposal } = await propRes.json();
    expect(proposal.clientId).toBe(OTHER_CLIENT_ID);

    // Promote the rule with art_director role
    const promoteRes = await app.request(`/clients/${OTHER_CLIENT_ID}/candidate-rules/${proposal.id}/promote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${artDirectorToken}`,
      },
    });
    expect(promoteRes.status).toBe(200);

    // Verify KAAE rules remain completely untouched
    const kaaePromoted = globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID);
    expect(kaaePromoted.some((r) => r.includes('#FF6F61'))).toBe(false);

    // Verify KAAE DNA file on disk was not modified
    if (initialKaaeDna) {
      const currentKaaeDna = fs.readFileSync(kaaeDnaPath, 'utf-8');
      expect(currentKaaeDna).toBe(initialKaaeDna);
    }
  });

  it('3. A candidate rule proposed for review (Desk queue) affects scope ONLY after activation', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

    // Rules said in chat by the office are saved as active client rules in PostgreSQL
    // (telegram-understanding.test.ts). Rules mined from edits still queue here for review.
    globalFeedbackMiner.proposeExplicitRule({
      clientId: KAAE_CLIENT_ID,
      taskId: 'task_h11_03',
      title: 'Ceremonial prose face',
      category: 'typography',
      ruleText: 'Apply Playfair Display for ceremonial prose',
      rationale: 'Mined from an art director edit',
      actor: { id: 'op1', role: 'operator' },
    });

    // Verify candidate rule was PROPOSED (not yet PROMOTED)
    const proposed = globalFeedbackMiner
      .getCandidateRules(KAAE_CLIENT_ID)
      .find((r) => r.ruleText.includes('Playfair Display') && r.status === 'PROPOSED');
    expect(proposed).toBeDefined();
    expect(proposed?.status).toBe('PROPOSED');

    // Before activation, active promoted rules do NOT include this proposal
    const activeBeforeActivation = globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID);
    expect(activeBeforeActivation.includes(proposed!.ruleText)).toBe(false);

    // Operator cannot promote (403 Forbidden)
    const opPromoteRes = await app.request(`/clients/${KAAE_CLIENT_ID}/candidate-rules/${proposed!.id}/promote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${operatorToken}`,
      },
    });
    expect(opPromoteRes.status).toBe(403);

    // Authorized creative_director promotes the rule
    const cdPromoteRes = await app.request(`/clients/${KAAE_CLIENT_ID}/candidate-rules/${proposed!.id}/promote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${artDirectorToken}`,
      },
    });
    expect(cdPromoteRes.status).toBe(200);

    // After activation, active promoted rules now include this rule
    const activeAfterActivation = globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID);
    expect(activeAfterActivation.includes(proposed!.ruleText)).toBe(true);
  });

  it('4. Conflicting rules stay pending and are rejected from promotion', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

    // Propose an explicit rule with orientation right
    const ruleRight = globalFeedbackMiner.proposeExplicitRule({
      clientId: KAAE_CLIENT_ID,
      taskId: 'task_spatial_01',
      title: 'Right aligned emblem',
      category: 'layout',
      ruleText: 'Always align official seal to the right edge',
      rationale: 'Right layout mandate',
      actor: { id: 'op1', role: 'operator' },
    });
    const promoteRight = globalFeedbackMiner.promoteRule(ruleRight.id, 'creative_director');
    expect(promoteRight.promoted).toBe(true);

    // Propose a contradictory rule: left aligned emblem
    const ruleLeft = globalFeedbackMiner.proposeExplicitRule({
      clientId: KAAE_CLIENT_ID,
      taskId: 'task_spatial_02',
      title: 'Left aligned emblem',
      category: 'layout',
      ruleText: 'Always align official seal to the left edge',
      rationale: 'Left layout mandate',
      actor: { id: 'op1', role: 'operator' },
      existingRules: globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID),
    });

    // Conflict detection must flag the spatial contradiction
    expect(ruleLeft.conflicts.length).toBeGreaterThan(0);
    expect(ruleLeft.conflicts[0]).toContain('orientation conflicts with existing rule');

    // Promotion must be rejected because conflicts are pending
    const promoteLeft = globalFeedbackMiner.promoteRule(ruleLeft.id, 'creative_director');
    expect(promoteLeft.promoted).toBe(false);
    expect(promoteLeft.reason).toBe('CONFLICTING_RULES_PENDING');

    // API endpoint also returns 409 Conflict
    const apiPromoteRes = await app.request(`/clients/${KAAE_CLIENT_ID}/candidate-rules/${ruleLeft.id}/promote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${artDirectorToken}`,
      },
    });
    expect(apiPromoteRes.status).toBe(409);
    const apiBody = await apiPromoteRes.json();
    expect(apiBody.title).toBe('Conflict');
  });

  it('6. Reversible rollback restores prior state and removes rule from generation scope', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

    // Propose and promote a test rule
    const testRule = globalFeedbackMiner.proposeExplicitRule({
      clientId: KAAE_CLIENT_ID,
      taskId: 'task_rollback_01',
      title: 'Temporary Test Accent',
      category: 'palette',
      ruleText: 'Use temporary accent token #123456',
      rationale: 'Temporary trial',
      actor: { id: 'director1', role: 'creative_director' },
    });
    const promo = globalFeedbackMiner.promoteRule(testRule.id, 'creative_director');
    expect(promo.promoted).toBe(true);
    expect(globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID)).toContain(testRule.ruleText);

    // Rollback the promoted rule
    const rollbackRes = await app.request(`/clients/${KAAE_CLIENT_ID}/candidate-rules/${testRule.id}/rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${artDirectorToken}`,
      },
      body: JSON.stringify({
        reason: 'Client requested removal of temporary accent #123456',
      }),
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackBody = await rollbackRes.json();
    expect(rollbackBody.rolledBack).toBe(true);
    expect(rollbackBody.auditHash).toBeDefined();

    // Rule status is now DISMISSED and no longer in active promoted rules
    expect(globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID)).not.toContain(testRule.ruleText);
  });

  it('7. Enforces data lineage separation between client-owned assets and restricted Canva items', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

    const lineageRes = await app.request(`/clients/${KAAE_CLIENT_ID}/learning/data-lineage?purpose=client_generation`, {
      method: 'GET',
    });
    expect(lineageRes.status).toBe(200);
    const lineage = await lineageRes.json();

    expect(lineage.permittedItems.length).toBeGreaterThan(0);
    expect(lineage.permittedItems.every((i: any) => i.lineage === 'client_owned')).toBe(true);
    expect(lineage.restrictedExcludedItems.some((i: any) => i.lineage === 'canva_derived_restricted')).toBe(true);

    // For external fine-tuning / benchmark, permitted items MUST be empty
    const extLineageRes = await app.request(`/clients/${KAAE_CLIENT_ID}/learning/data-lineage?purpose=external_fine_tuning`, {
      method: 'GET',
    });
    const extLineage = await extLineageRes.json();
    expect(extLineage.permittedItems.length).toBe(0);
    expect(extLineage.restrictedExcludedItems.length).toBeGreaterThan(0);
  });
});
