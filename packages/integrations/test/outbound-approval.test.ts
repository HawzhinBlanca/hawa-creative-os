import { describe, it, expect } from 'vitest';
import {
  buildOutboundReviewDispatch,
  ACTION_LINK_TTL_MS,
  computeActionSignature,
  signActionLink,
  verifyActionLink,
  verifyActionSignature,
  type CampaignReviewDispatchPayload,
} from '../src/outbound-notifier.js';

describe('Two-Way Outbound Approval Dispatcher', () => {
  const samplePayload: CampaignReviewDispatchPayload = {
    taskId: 'task_review_123',
    clientId: 'client-drustee',
    clientName: 'Drustee Evidence-First Health',
    recipientPhone: '+9647501234567',
    headlineCkb: 'ڤیتامین D3 + K2 ی زانستی',
    headlineEn: 'Pure Vitamin D3 + K2',
    copyCkb: '٣٤ دۆلار · کوالێتی باوەڕپێکراو',
    copyEn: '$34.00 · Clinical Grade',
    brandName: 'Drustee',
    formats: ['feed', 'story', 'square', 'landscape'],
    callbackBaseUrl: 'http://localhost:3001',
  };

  it('builds formatted bilingual review dispatch with interactive action callbacks', () => {
    const dispatch = buildOutboundReviewDispatch(samplePayload);

    expect(dispatch.taskId).toBe('task_review_123');
    expect(dispatch.clientId).toBe('client-drustee');
    expect(dispatch.status).toBe('SENT');
    expect(dispatch.messageText).toContain('کەمپینی نوێ ئامادەیە بۆ پێداچوونەوە');
    expect(dispatch.messageText).toContain('ڤیتامین D3 + K2 ی زانستی');
    expect(dispatch.messageText).toContain('4-in-1');

    expect(dispatch.actions.length).toBe(2);
    const [approveAction, revisionAction] = dispatch.actions;

    expect(approveAction.action).toBe('approve');
    expect(approveAction.callbackUrl).toContain('action=approve');
    expect(approveAction.callbackUrl).toContain('taskId=task_review_123');
    expect(approveAction.signature).toBeDefined();

    expect(revisionAction.action).toBe('revision');
    expect(revisionAction.callbackUrl).toContain('action=revision');
  });

  it('signs review links over the action, publish flag, 72-hour expiry and phone (ADR-159)', () => {
    const now = Date.parse('2026-09-30T08:00:00Z');
    const [approve] = buildOutboundReviewDispatch({ ...samplePayload, now }).actions;
    const query = new URL(approve.callbackUrl).searchParams;
    const exp = Math.floor((now + ACTION_LINK_TTL_MS) / 1000);
    expect(Object.fromEntries(query)).toEqual({ taskId: 'task_review_123', action: 'approve', publish: 'false',
      exp: String(exp), sig: approve.signature, phone: samplePayload.recipientPhone });
    const claims = { taskId: 'task_review_123', action: 'approve' as const, publish: false, exp, phone: samplePayload.recipientPhone };
    expect(verifyActionLink(claims, approve.signature, now)).toBe('valid');
    expect(verifyActionLink({ ...claims, publish: true }, approve.signature, now)).toBe('invalid');
    expect(verifyActionLink({ ...claims, action: 'revision' }, approve.signature, now)).toBe('invalid');
    expect(verifyActionLink({ ...claims, exp: exp + 1 }, approve.signature, now)).toBe('invalid');
    expect(verifyActionLink({ ...claims, phone: undefined }, approve.signature, now)).toBe('invalid');
    expect(verifyActionLink(claims, approve.signature, exp * 1000)).toBe('expired');
    expect(verifyActionLink(claims, computeActionSignature('task_review_123', 'approve'), now)).toBe('invalid');
    expect(signActionLink(claims)).toBe(approve.signature);
  });

  it('verifies valid HMAC signatures and rejects forged signatures', () => {
    const sig = computeActionSignature('task_review_123', 'approve');
    expect(verifyActionSignature('task_review_123', 'approve', sig)).toBe(true);

    // Reject forged action
    expect(verifyActionSignature('task_review_123', 'revision', sig)).toBe(false);
    // Reject forged taskId
    expect(verifyActionSignature('other_task_999', 'approve', sig)).toBe(false);
    // Reject tampered signature
    expect(verifyActionSignature('task_review_123', 'approve', 'bad_sig_12345')).toBe(false);
    // Reject explicit short_bypass backdoor
    expect(verifyActionSignature('task_review_123', 'approve', 'short_bypass')).toBe(false);
    expect(verifyActionSignature('task_review_123', 'revision', 'short_bypass')).toBe(false);
  });
});
