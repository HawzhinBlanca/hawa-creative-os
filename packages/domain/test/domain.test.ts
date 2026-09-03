import { describe, it, expect } from 'vitest';
import {
  TaskStateMachine,
  extractProtectedTokens,
  validateBrief,
  verifyApprovalEligibility,
  promoteCandidateRule,
  type DesignBrief,
  type ApprovalDecision,
  type CandidateRule,
} from '../src/index.js';

describe('Domain: TaskStateMachine', () => {
  it('allows legal forward progression', () => {
    const sm = new TaskStateMachine('task-123', 'RECEIVED');
    expect(sm.getStatus()).toBe('RECEIVED');

    const t1 = sm.transition('ROUTING', { type: 'workflow', id: 'wf-1' }, 'Starting routing');
    expect(t1.ok).toBe(true);
    expect(sm.getStatus()).toBe('ROUTING');

    const t2 = sm.transition('BRIEFING', { type: 'workflow', id: 'wf-1' }, 'Routing resolved');
    expect(t2.ok).toBe(true);
    expect(sm.getStatus()).toBe('BRIEFING');
  });

  it('rejects illegal transitions', () => {
    const sm = new TaskStateMachine('task-123', 'RECEIVED');
    const res = sm.transition('APPROVED', { type: 'user', id: 'u-1' }, 'Skipping workflow');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('ILLEGAL_STATE_TRANSITION');
      expect(res.error.classification).toBe('terminal_policy_failure');
    }
  });

  it('enforces maximum 2 repair cycles before escalating to operator', () => {
    const sm = new TaskStateMachine('task-123', 'QA');
    const r1 = sm.transition('REPAIRING', { type: 'workflow', id: 'wf-1' }, 'Repair cycle 1');
    expect(r1.ok).toBe(true);
    expect(sm.getRepairCount()).toBe(1);

    sm.transition('QA', { type: 'workflow', id: 'wf-1' }, 'Back to QA');
    const r2 = sm.transition('REPAIRING', { type: 'workflow', id: 'wf-1' }, 'Repair cycle 2');
    expect(r2.ok).toBe(true);
    expect(sm.getRepairCount()).toBe(2);

    sm.transition('QA', { type: 'workflow', id: 'wf-1' }, 'Back to QA');
    const r3 = sm.transition('REPAIRING', { type: 'workflow', id: 'wf-1' }, 'Attempt repair 3');
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe('MAX_REPAIR_BUDGET_EXCEEDED');
      expect(r3.error.classification).toBe('human_resolvable_ambiguity');
    }
  });
});

describe('Domain: Brief & Protected Tokens', () => {
  it('extracts prices, urls, and phone numbers as protected tokens', () => {
    const text = 'Call 07501234567 for special discount 25,000 IQD visit https://hawadesign.com';
    const tokens = extractProtectedTokens(text);
    expect(tokens.some((t) => t.type === 'phone')).toBe(true);
    expect(tokens.some((t) => t.type === 'price')).toBe(true);
    expect(tokens.some((t) => t.type === 'url')).toBe(true);
  });

  it('blocks brief validation if blocking missing facts exist', () => {
    const brief: DesignBrief = {
      briefId: 'b-1',
      taskId: 't-1',
      clientId: 'c-1',
      clientDnaVersion: 1,
      objective: 'Campaign poster',
      taskRoute: 'creative_director',
      primaryLanguage: 'ckb',
      direction: 'rtl',
      variants: [{ id: 'v1', name: 'post', width: 1080, height: 1080, aspectRatio: '1:1', role: 'instagram_post' }],
      exactCopy: [{ id: 'ec1', role: 'headline', text: 'داشکاندنی تایبەت', language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] }],
      missingFacts: [
        { field: 'event_date', question: 'What is the date of the event?', impact: 'critical', blocking: true },
      ],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    const res = validateBrief(brief);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('BRIEF_HAS_MISSING_FACTS');
    }
  });
});

describe('Domain: Approval Decision Eligibility', () => {
  it('rejects approval if source revision hash changed', () => {
    const decision: ApprovalDecision = {
      decisionId: 'dec-1',
      taskId: 't-1',
      designRevisionId: 'rev-1',
      sourceHash: 'sha-old-123',
      qcReportHash: 'qc-hash-1',
      decision: 'approved',
      actor: { userId: 'u-1', displayName: 'Hawzhin', role: 'art_director', verifiedServerSide: true },
      decidedAt: new Date().toISOString(),
    };

    const res = verifyApprovalEligibility(decision, 'sha-new-456', 'qc-hash-1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('STALE_REVISION_APPROVAL');
    }
  });

  it('accepts approval when hashes match and actor is server-verified', () => {
    const decision: ApprovalDecision = {
      decisionId: 'dec-1',
      taskId: 't-1',
      designRevisionId: 'rev-1',
      sourceHash: 'sha-exact-123',
      qcReportHash: 'qc-hash-1',
      decision: 'approved',
      actor: { userId: 'u-1', displayName: 'Hawzhin', role: 'art_director', verifiedServerSide: true },
      decidedAt: new Date().toISOString(),
    };

    const res = verifyApprovalEligibility(decision, 'sha-exact-123', 'qc-hash-1');
    expect(res.ok).toBe(true);
  });
});

describe('Domain: Governed Feedback Promotion', () => {
  it('promotes candidate rule to Client DNA with human audit record', () => {
    const candidate: CandidateRule = {
      candidateRuleId: 'cr-1',
      clientId: 'c-1',
      category: 'color',
      suggestedRuleText: 'Do not place yellow text on white background',
      supportingFeedbackIds: ['fb-1', 'fb-2'],
      confidenceScore: 0.92,
      status: 'pending_review',
      proposedAt: new Date().toISOString(),
    };

    const res = promoteCandidateRule(candidate, 'user-admin-1', 'Never use yellow text on white background.');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.ruleText).toBe('Never use yellow text on white background.');
      expect(res.value.clientId).toBe('c-1');
    }
  });
});
