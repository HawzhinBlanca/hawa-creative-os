import type { UUID, ISODateTime, JsonObject, Result, AppError } from '@hawa/contracts';

export type FeedbackPolarity = 'positive' | 'negative' | 'neutral';

export interface FeedbackEvent {
  feedbackId: UUID;
  taskId: UUID;
  clientId: UUID;
  projectId?: UUID;
  designRevisionId: UUID;
  nodeId?: string;
  polarity: FeedbackPolarity;
  category: 'typography' | 'color' | 'layout' | 'brand_voice' | 'cultural' | 'image_subject' | 'other';
  rawFeedbackText: string;
  attributedActor: {
    userId: UUID;
    displayName: string;
  };
  governance: {
    status: 'received' | 'mined' | 'rule_proposed' | 'rule_promoted' | 'dismissed';
    promotedRuleId?: UUID;
    promotedByUserId?: UUID;
  };
  occurredAt: ISODateTime;
}

export interface CandidateRule {
  candidateRuleId: UUID;
  clientId: UUID;
  category: string;
  suggestedRuleText: string;
  supportingFeedbackIds: UUID[];
  confidenceScore: number;
  status: 'pending_review' | 'promoted' | 'rejected';
  proposedAt: ISODateTime;
}

export function promoteCandidateRule(
  candidate: CandidateRule,
  promotedByUserId: UUID,
  officialRuleText: string
): Result<{ promotedRuleId: UUID; ruleText: string; clientId: UUID }, AppError> {
  if (!promotedByUserId) {
    return {
      ok: false,
      error: {
        code: 'PROMOTION_REQUIRES_HUMAN_ACTOR',
        message: 'A candidate rule can only be promoted to Client DNA by an authorized human administrator',
        retryable: false,
        safeAction: 'Review rule candidate in Hawa Desk Feedback Governance panel',
      },
    };
  }

  return {
    ok: true,
    value: {
      promotedRuleId: crypto.randomUUID(),
      ruleText: officialRuleText || candidate.suggestedRuleText,
      clientId: candidate.clientId,
    },
  };
}
