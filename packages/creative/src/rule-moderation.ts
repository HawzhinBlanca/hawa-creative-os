import { createHash } from 'node:crypto';
import { canonicalJson } from '@hawa/domain';
import type { CandidateRuleProposal } from './feedback-miner.js';
export type RuleModerationAction = 'promote' | 'dismiss' | 'rollback';
export class RuleModerationConflict extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
}
/** Pure transition: it never modifies the review queue or Client DNA. */
export function planRuleModeration(rule: CandidateRuleProposal, action: RuleModerationAction, actor: {
    id: string;
    role: string;
}, reason: string, at: string) {
    const directors = ['art_director', 'creative_director', 'administrator'];
    if (!actor.id || !(action === 'dismiss' ? [...directors, 'operator'] : directors).includes(actor.role)) {
        throw new RuleModerationConflict('RULE_MODERATION_FORBIDDEN', 'The verified actor cannot perform this action.');
    }
    if (action === 'promote' && rule.status === 'DISMISSED')
        throw new RuleModerationConflict('RULE_DISMISSED', 'A dismissed rule needs a new reviewed proposal.');
    if (action === 'promote' && rule.conflicts.length)
        throw new RuleModerationConflict('CONFLICTING_RULES_PENDING', 'The candidate has unresolved conflicts.');
    if (action === 'dismiss' && rule.status === 'PROMOTED')
        throw new RuleModerationConflict('RULE_ALREADY_ACTIVE', 'Use rollback to retire an active rule.');
    if (action === 'rollback' && rule.status === 'PROPOSED')
        throw new RuleModerationConflict('RULE_NOT_ACTIVE', 'Only an active rule can be rolled back.');
    const proposal = structuredClone(rule);
    proposal.status = action === 'promote' ? 'PROMOTED' : 'DISMISSED';
    if (action === 'promote' && rule.status !== 'PROMOTED') {
        proposal.promotedByRole = actor.role as 'art_director' | 'creative_director' | 'administrator';
        proposal.promotedAt = at;
    }
    return {
        proposal, changed: proposal.status !== rule.status,
        auditHash: createHash('sha256').update(canonicalJson({ action, actor, reason, at, proposal })).digest('hex')
    };
}
