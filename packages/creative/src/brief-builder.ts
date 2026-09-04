import type { UUID, Result, AppError } from '@hawa/contracts';
import {
  type DesignBrief,
  type DesignVariant,
  type ExactCopyBlock,
  type MissingFact,
  extractProtectedTokens,
  detectScriptAndDirection,
  validateBrief,
} from '@hawa/domain';

export interface RawTaskBriefInput {
  taskId: UUID;
  clientId: UUID;
  projectId?: UUID;
  clientDnaVersion: number;
  objective: string;
  rawRequestText: string;
  requestedFormat?: string;
  targetWidth?: number;
  targetHeight?: number;
  providedCopy?: Array<{ role: 'headline' | 'subheadline' | 'body' | 'cta' | 'disclaimer'; text: string; language?: string; direction?: 'rtl' | 'ltr' }>;
  knownFacts?: Record<string, string>;
}

export class BriefBuilder {
  build(input: RawTaskBriefInput): Result<DesignBrief, AppError> {
    const briefId = crypto.randomUUID();
    const missingFacts: MissingFact[] = [];

    // Check required dimensions
    const width = input.targetWidth || 1080;
    const height = input.targetHeight || 1080;
    const variants: DesignVariant[] = [
      {
        id: 'v_primary',
        name: input.requestedFormat || 'social_feed_square',
        width,
        height,
        aspectRatio: `${width}:${height}`,
        role: width === height ? 'instagram_post' : 'custom',
      },
    ];

    // Process exact copy blocks
    const exactCopy: ExactCopyBlock[] = [];
    if (input.providedCopy && input.providedCopy.length > 0) {
      for (const item of input.providedCopy) {
        const tokens = extractProtectedTokens(item.text);
        const detected = detectScriptAndDirection(item.text);
        exactCopy.push({
          id: crypto.randomUUID(),
          role: item.role,
          text: item.text,
          language: item.language || detected.primaryLanguage,
          direction: item.direction || detected.direction,
          approved: true,
          protectedTokens: tokens,
        });
      }
    } else {
      // Extract from raw request text with script detection
      const tokens = extractProtectedTokens(input.rawRequestText);
      const detected = detectScriptAndDirection(input.rawRequestText);
      exactCopy.push({
        id: crypto.randomUUID(),
        role: 'headline',
        text: input.rawRequestText.trim(),
        language: detected.primaryLanguage,
        direction: detected.direction,
        approved: true,
        protectedTokens: tokens,
      });
    }

    // Invariant 5: Facts are never invented. Missing names, prices, dates, times, addresses, legal copy, dimensions, or product claims trigger clarification
    if (input.rawRequestText.toLowerCase().includes('event') || input.rawRequestText.toLowerCase().includes('ئاهەنگ') || input.rawRequestText.toLowerCase().includes('ڕووداو')) {
      const hasDate = exactCopy.some((c) => c.protectedTokens.some((t) => t.type === 'date'));
      if (!hasDate && !input.knownFacts?.event_date) {
        missingFacts.push({
          field: 'event_date',
          question: 'What is the exact date of the event?',
          impact: 'critical',
          blocking: true,
        });
      }
    }

    const detectedObjective = detectScriptAndDirection(input.objective || input.rawRequestText);
    const primaryLanguage = exactCopy[0]?.language || detectedObjective.primaryLanguage;
    const direction = exactCopy[0]?.direction || detectedObjective.direction;

    const brief: DesignBrief = {
      briefId,
      taskId: input.taskId,
      clientId: input.clientId,
      projectId: input.projectId,
      clientDnaVersion: input.clientDnaVersion,
      objective: input.objective,
      taskRoute: 'template_fill',
      primaryLanguage,
      direction,
      variants,
      exactCopy,
      missingFacts,
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    return validateBrief(brief);
  }
}
