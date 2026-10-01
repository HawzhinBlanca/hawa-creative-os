import { describe, expect, it, vi } from 'vitest';
import { FeedbackMiner, type DesignFeedbackRecord } from '../src/feedback-miner.js';

const event = (patch: Partial<DesignFeedbackRecord> = {}): DesignFeedbackRecord => ({
  id: 'feedback-1', tenantId: 'office-1', clientId: 'client-a', taskId: 'task-a',
  actorId: 'reviewer-1', verdict: 'revise', notes: 'Increase title spacing for this design',
  ...patch,
});

describe('Authoritative feedback attribution and independent evidence', () => {
  it('refuses absent scope instead of assigning a real client', () => {
    const miner = new FeedbackMiner();
    expect(() => miner.ingestDesignFeedback(event({ clientId: undefined }))).toThrow(/client/i);
  });
  it('accepts explicit context and refuses contradictory record scope', () => {
    const miner = new FeedbackMiner();
    expect(miner.ingestDesignFeedback(event({ clientId: undefined }), { clientId: 'client-b' })[0].clientId).toBe('client-b');
    expect(() => miner.ingestDesignFeedback(event({ id: 'feedback-2' }), { clientId: 'client-b' })).toThrow(/client/i);
    expect(miner.getCandidateRules('client-a')).toHaveLength(0);
  });
  it('rejects a malformed batch before creating any valid earlier proposal', () => {
    const miner = new FeedbackMiner();
    expect(() => miner.ingestDesignFeedback([event(), event({ id: 'feedback-2', clientId: undefined })])).toThrow();
    expect(miner.getCandidateRules('client-a')).toHaveLength(0);
  });
  it('does not invent an art-director role', () => {
    const rule = new FeedbackMiner().ingestDesignFeedback(event())[0];
    expect(rule.provenance.actor).toEqual({ id: 'reviewer-1' });
  });
  it('makes exact event replay inert including negative evidence', () => {
    const miner = new FeedbackMiner();
    const input = event({ verdict: 'reject' });
    const negatives = vi.spyOn(miner, 'recordNegativeFeedback');
    const rule = miner.ingestDesignFeedback(input)[0];
    const before = JSON.stringify(rule);
    expect(miner.ingestDesignFeedback({ ...input })).toHaveLength(0);
    expect(JSON.stringify(rule)).toBe(before);
    expect(negatives).toHaveBeenCalledTimes(1);
  });
  it('refuses changed event reuse and leaves its original evidence intact', () => {
    const miner = new FeedbackMiner();
    const rule = miner.ingestDesignFeedback(event())[0];
    expect(() => miner.ingestDesignFeedback(event({ verdict: 'reject' }))).toThrow(/conflict|reuse/i);
    expect(rule.frequency).toBe(1);
    expect(miner.isTaskRejected('task-a')).toBe(false);
  });
  it('refuses contradictory event identities within one batch atomically', () => {
    const miner = new FeedbackMiner();
    expect(() => miner.ingestDesignFeedback([event(), event({ clientId: 'client-b' })])).toThrow();
    expect(miner.getCandidateRules('client-a')).toHaveLength(0);
    expect(miner.getCandidateRules('client-b')).toHaveLength(0);
  });
  it('does not use an unrelated approved design as support for a rule', () => {
    const miner = new FeedbackMiner();
    const rule = miner.ingestDesignFeedback(event())[0];
    miner.ingestDesignFeedback(event({ id: 'feedback-2', taskId: 'task-b', verdict: 'approve', notes: null }));
    expect(rule.examples.positiveExampleTaskIds).toEqual([]);
    miner.ingestDesignFeedback(event({ id: 'feedback-3', verdict: 'approve', notes: null }));
    expect(rule.examples.positiveExampleTaskIds).toEqual(['task-a']);
  });
  it('keeps rejection effects within the stated client', () => {
    const miner = new FeedbackMiner();
    const a = miner.ingestDesignFeedback(event({ verdict: 'approve' }))[0];
    miner.ingestDesignFeedback(event({ id: 'feedback-2', clientId: 'client-b', verdict: 'reject' }));
    expect(a.examples.positiveExampleTaskIds).toEqual(['task-a']);
    expect(a.examples.negativeExampleTaskIds).toEqual([]);
    expect(miner.ingestDesignFeedback(event({ id: 'feedback-3', taskId: 'task-c', verdict: 'approve' }))[0].clientId).toBe('client-a');
  });
});
