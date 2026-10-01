import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { createDb } from '@hawa/db';
import {
  FeedbackMiner,
  type ArtboardSnapshot,
} from '@hawa/creative';

describe('CV-18: Governed Learning and Permitted Data Lineage', () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const app = createAppWithClientFixtures({ db });

  const testBearer = process.env.HAWA_ART_DIRECTOR_KEY!;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${testBearer}`,
  };

  let miner: FeedbackMiner;

  beforeEach(() => {
    miner = new FeedbackMiner();
  });

  it('mines AST deltas into candidate rules with strict client provenance', () => {
    const initial: ArtboardSnapshot = {
      taskId: 'task_101',
      clientId: 'client_drustee',
      layers: [
        { id: 'el_1', type: 'text', text: 'Old Head', fontFamily: 'Arial', fontSize: 24, color: '#000000', x: 0, y: 0, width: 200, height: 40 },
        { id: 'el_2', type: 'shape', color: '#ff0000', x: 0, y: 0, width: 100, height: 100 },
      ],
    };

    const refined: ArtboardSnapshot = {
      taskId: 'task_101',
      clientId: 'client_drustee',
      layers: [
        { id: 'el_1', type: 'text', text: 'New Kurdish Title', fontFamily: 'Vazirmatn', fontSize: 32, color: '#111827', x: 0, y: 0, width: 300, height: 60 },
        { id: 'el_2', type: 'shape', color: '#0284c7', x: 0, y: 0, width: 100, height: 100 },
      ],
    };

    const rules = miner.ingestTaskRefinements('client_drustee', 'task_101', initial, refined);

    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const r of rules) {
      expect(r.clientId).toBe('client_drustee');
      expect(r.scope).toBe('client_scoped');
      expect(r.status).toBe('PROPOSED');
      expect(r.dataLineage).toBe('client_owned');
      expect(r.provenance.taskId).toBe('task_101');
      expect(r.provenance.clientId).toBe('client_drustee');
      expect(r.examples.positiveExampleTaskIds).toEqual([]); // No verified approval supplied.
      expect(r.examples.negativeExampleTaskIds).toHaveLength(0);
    }
  });

  it('detects conflicts against client prohibited phrases and contradictory layout rules', () => {
    const existingRules = ['Primary logo must align to top-left corner', 'Always include official medical disclaimer'];
    const prohibitedPhrases = ['100% Guaranteed Cure', 'Miracle Healing'];

    // 1. Prohibited phrase contradiction
    const conflicts1 = miner.detectConflicts(
      'Use the headline "100% Guaranteed Cure for All Ailments"',
      existingRules,
      prohibitedPhrases
    );
    expect(conflicts1.some((c) => c.includes('prohibited phrase'))).toBe(true);

    // 2. Spatial contradiction (right vs left)
    const conflicts2 = miner.detectConflicts(
      'Place brand mark at top-right corner',
      existingRules,
      prohibitedPhrases
    );
    expect(conflicts2.some((c) => c.includes('orientation conflicts'))).toBe(true);

    // 3. Negative contradiction
    const conflicts3 = miner.detectConflicts(
      'Never include official medical disclaimer on social cards',
      existingRules,
      prohibitedPhrases
    );
    expect(conflicts3.some((c) => c.includes('restriction conflicts with existing affirmative rule'))).toBe(true);
  });

  it('records negative feedback and prevents rejected designs from becoming positive examples', () => {
    // Propose an explicit rule with a task
    const proposal = miner.proposeExplicitRule({
      clientId: 'client_drustee',
      taskId: 'task_rejected_55',
      title: 'Dense bottom padding',
      category: 'layout',
      ruleText: 'Keep bottom padding strictly under 10px',
      rationale: 'Operator experiment',
      actor: { id: 'designer_4', role: 'designer', name: 'Zana' },
    });

    expect(proposal.examples.positiveExampleTaskIds).toEqual([]); // An instruction is not a design approval.

    // Operator records negative feedback on the task
    const negRes = miner.recordNegativeFeedback(
      'task_rejected_55',
      'client_drustee',
      'Design rejected: Bottom padding is crowded and clips the disclaimer text on mobile.',
      { id: 'art_dir_1', role: 'art_director', name: 'Hawa Art Lead' }
    );

    expect(negRes.negativeExampleRecorded).toBe(true);

    // Verify task is stripped from positive examples and added to negative examples
    const updatedRule = miner.getCandidateRules('client_drustee').find((r) => r.id === proposal.id);
    expect(updatedRule?.examples.positiveExampleTaskIds).not.toContain('task_rejected_55');
    expect(updatedRule?.examples.negativeExampleTaskIds).toContain('task_rejected_55');

    // Future ingestion for this rejected task will NOT create positive examples
    const dummySnapshot: ArtboardSnapshot = {
      taskId: 'task_rejected_55',
      clientId: 'client_drustee',
      layers: [{ id: 'el_3', type: 'text', text: 'Text', fontFamily: 'Inter', fontSize: 16, x: 0, y: 0, width: 100, height: 20 }],
    };
    const refSnapshot: ArtboardSnapshot = {
      taskId: 'task_rejected_55',
      clientId: 'client_drustee',
      layers: [{ id: 'el_3', type: 'text', text: 'Text', fontFamily: 'Vazirmatn', fontSize: 16, x: 0, y: 0, width: 100, height: 20 }],
    };
    const mined = miner.ingestTaskRefinements('client_drustee', 'task_rejected_55', dummySnapshot, refSnapshot);
    for (const r of mined) {
      expect(r.examples.positiveExampleTaskIds).not.toContain('task_rejected_55');
      expect(r.examples.negativeExampleTaskIds).toContain('task_rejected_55');
    }
  });

  it('requires human sign-off gate to promote candidate rules and allows reversible rollback', () => {
    const proposal = miner.proposeExplicitRule({
      clientId: 'client_rona',
      taskId: 'task_rona_1',
      title: 'Sorani Orthography Mandatory',
      category: 'copy_token',
      ruleText: 'Always use standard Kurdish Sorani unicode characters (ڕ, ڵ, ێ, ۆ)',
      rationale: 'Brand linguistic standards',
      actor: { id: 'editor_1', role: 'linguist', name: 'Linguistic Reviewer' },
    });

    expect(proposal.status).toBe('PROPOSED');

    // Promote rule with human sign-off
    const promoRes = miner.promoteRule(proposal.id, 'art_director');
    expect(promoRes.promoted).toBe(true);
    expect(promoRes.rule?.status).toBe('PROMOTED');
    expect(promoRes.rule?.promotedByRole).toBe('art_director');
    expect(promoRes.auditHash).toBeDefined();

    // Reversibly rollback rule
    const rollRes = miner.rollbackPromotedRule(proposal.id, 'lead_ad', 'Testing rollback workflow');
    expect(rollRes.rolledBack).toBe(true);
    expect(rollRes.rule?.status).toBe('DISMISSED');
    expect(rollRes.auditHash).toBeDefined();
  });

  it('enforces multi-client isolation between client rules', () => {
    miner.proposeExplicitRule({
      clientId: 'client_drustee',
      taskId: 'task_dr_1',
      title: 'Drustee Rule',
      category: 'palette',
      ruleText: 'Primary brand blue #0284c7',
      rationale: 'Drustee color spec',
      actor: { id: 'user_1' },
    });

    miner.proposeExplicitRule({
      clientId: 'client_fastpay',
      taskId: 'task_fp_1',
      title: 'FastPay Rule',
      category: 'palette',
      ruleText: 'Primary brand yellow #eab308',
      rationale: 'FastPay color spec',
      actor: { id: 'user_2' },
    });

    const drusteeRules = miner.getCandidateRules('client_drustee');
    const fastpayRules = miner.getCandidateRules('client_fastpay');

    expect(drusteeRules.every((r) => r.clientId === 'client_drustee')).toBe(true);
    expect(fastpayRules.every((r) => r.clientId === 'client_fastpay')).toBe(true);
    expect(drusteeRules.some((r) => r.title === 'FastPay Rule')).toBe(false);
  });

  it('strictly isolates data retrieval boundary and excludes Canva restricted IP from external fine-tuning and benchmarks', () => {
    // Inventory is explicit test data; the miner never invents real client assets.
    const inventory = [
      {id:'owned-logo',clientId:'client_drustee',type:'logo',name:'Fixture logo',lineage:'client_owned' as const},
      {id:'restricted-template',clientId:'client_drustee',type:'template',name:'Fixture vendor item',lineage:'canva_derived_restricted' as const},
    ];
    // 1. Client generation query allows client-owned assets
    const genBoundary = miner.evaluateDataRetrievalBoundary('client_drustee', 'client_generation', inventory);
    expect(genBoundary.permittedItems.length).toBeGreaterThan(0);
    expect(genBoundary.permittedItems.every((i) => i.lineage === 'client_owned')).toBe(true);
    expect(genBoundary.restrictedExcludedItems.length).toBeGreaterThan(0);
    expect(genBoundary.restrictedExcludedItems.every((i) => i.lineage === 'canva_derived_restricted')).toBe(true);

    // 2. External fine-tuning query blocks both client-owned and Canva restricted assets
    const ftBoundary = miner.evaluateDataRetrievalBoundary('client_drustee', 'external_fine_tuning', inventory);
    expect(ftBoundary.permittedItems).toHaveLength(0);
    expect(ftBoundary.restrictedExcludedItems.some((i) => i.reason.includes('Vendor IP restriction'))).toBe(true);

    // 3. Benchmark query blocks export of proprietary Canva heuristics
    const bmBoundary = miner.evaluateDataRetrievalBoundary('client_drustee', 'benchmark', inventory);
    expect(bmBoundary.permittedItems).toHaveLength(0);
    expect(bmBoundary.restrictedExcludedItems.some((i) => i.id === 'restricted-template')).toBe(true);
  });

  it('exposes governed learning and data boundary endpoints via HTTP API', async () => {
    // 1. Propose explicit rule via HTTP
    const propRes = await app.request('/v1/clients/c1000000-0000-4000-8000-000000000003/candidate-rules/propose', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Logo Safety Margin',
        category: 'layout',
        ruleText: 'Maintain minimum 48px safety margin around brand mark',
        rationale: 'Avoid clipping on digital displays',
        existingRules: ['Place logo at top-left'],
        prohibitedPhrases: [],
      }),
    });
    expect(propRes.status).toBe(201);
    const propJson = await propRes.json();
    expect(propJson.proposal.id).toBeDefined();
    const ruleId = propJson.proposal.id;

    // 2. List candidate rules
    const listRes = await app.request('/v1/clients/c1000000-0000-4000-8000-000000000003/candidate-rules', {
      headers: authHeaders,
    });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.candidateRules.some((r: any) => r.id === ruleId)).toBe(true);

    // 3. Promote rule via HTTP
    const promoteRes = await app.request(`/v1/clients/c1000000-0000-4000-8000-000000000003/candidate-rules/${ruleId}/promote`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ role: 'creative_director' }),
    });
    expect(promoteRes.status).toBe(200);
    const promoteJson = await promoteRes.json();
    expect(promoteJson.promoted).toBe(true);

    // 4. Rollback promoted rule via HTTP
    const rollbackRes = await app.request(`/v1/clients/c1000000-0000-4000-8000-000000000003/candidate-rules/${ruleId}/rollback`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ reason: 'Reverting for operator review' }),
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackJson = await rollbackRes.json();
    expect(rollbackJson.rolledBack).toBe(true);

    // 5. Record negative feedback for an actual stored task via HTTP
    const taskRes=await app.request('/v1/tasks',{method:'POST',headers:authHeaders,body:JSON.stringify({
      clientId:'c1000000-0000-4000-8000-000000000003',title:'Isolated negative feedback',
    })});
    expect(taskRes.status).toBe(201);const task=await taskRes.json();
    const negRes = await app.request('/v1/clients/c1000000-0000-4000-8000-000000000003/negative-feedback', {
      method: 'POST',
      headers: {...authHeaders,'Idempotency-Key':randomUUID()},
      body: JSON.stringify({
        taskId: task.id,
        feedbackText: 'Color scheme violated high contrast accessibility standard',
      }),
    });
    expect(negRes.status).toBe(201);
    const negJson = await negRes.json();
    expect(negJson.negativeExampleRecorded).toBe(true);

    // 6. Query data lineage boundary via HTTP
    const lineRes = await app.request('/v1/clients/c1000000-0000-4000-8000-000000000003/learning/data-lineage?purpose=external_fine_tuning', {
      headers: authHeaders,
    });
    expect(lineRes.status).toBe(200);
    const lineJson = await lineRes.json();
    expect(lineJson.permittedItems).toHaveLength(0);
    expect(lineJson.restrictedExcludedItems).toEqual([]);
  });
});
