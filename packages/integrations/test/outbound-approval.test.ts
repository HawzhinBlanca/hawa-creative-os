import { describe, it, expect } from 'vitest';
import {
  buildOutboundReviewDispatch,
  computeActionSignature,
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
