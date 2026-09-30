import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_SPENDING_POLICY } from '@hawa/creative';
import { GATEWAY_SPENDING_POLICY_REVIEW_BY } from '@hawa/integrations';
import { createApp } from '../src/app.js';

/**
 * ADR-159 (audit 2026-09-30 #4): the Canva planner hard-stopped at a date written into its code
 * (2026-11-22), with no warning anywhere. The date now comes from the price policy, and /v1/health
 * warns from 14 days before it, in `dependencies` where the watchdog pages on anything not healthy.
 */
describe('price policy review date in /v1/health', () => {
  afterEach(() => { vi.useRealTimers(); });
  const health = async (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    const res = await createApp({ skipPaidModelProbe: true, skipTelegramProbe: true } as any).request('/v1/health');
    return res.json();
  };
  const reviewBy = Date.parse(STUDIO_SPENDING_POLICY.reviewBy), day = 86_400_000;

  it('both policies share the review date the planner enforces', () => {
    expect(STUDIO_SPENDING_POLICY.reviewBy).toBe('2026-11-22T00:00:00Z');
    expect(GATEWAY_SPENDING_POLICY_REVIEW_BY).toBe(STUDIO_SPENDING_POLICY.reviewBy);
  });
  it('says nothing to the watchdog while the prices are more than 14 days from review', async () => {
    const body = await health(new Date(reviewBy - 15 * day).toISOString());
    expect(body.spendingPolicy).toMatchObject({ status: 'valid' });
    expect(body.spendingPolicy.policies).toContainEqual(expect.objectContaining({ policy: STUDIO_SPENDING_POLICY.id, daysLeft: 15 }));
    expect(body.dependencies.spendingPolicy).toBeUndefined();
  });
  it('warns from 14 days before the review date, naming what to do', async () => {
    const body = await health(new Date(reviewBy - 14 * day).toISOString());
    expect(body.spendingPolicy).toMatchObject({ status: 'expiring', warning: expect.stringContaining('runbooks/SPENDING_POLICY.md') });
    expect(body.dependencies.spendingPolicy).toBe('expiring');
    expect(body.status).not.toBe('healthy');
  });
  it('reports the policy expired from the review date', async () => {
    const body = await health(new Date(reviewBy).toISOString());
    expect(body.spendingPolicy.status).toBe('expired');
    expect(body.dependencies.spendingPolicy).toBe('expired');
  });
});
