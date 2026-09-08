import type { DesignBrief } from '@hawa/domain';

export type TaskRoute = 'template_fill' | 'editable_composition' | 'creative_director' | 'human_only';
export type FigmaRoute = 'buzz_template' | 'figma_freeform' | 'human';

export interface RouteResolution {
  route: TaskRoute;
  figmaRoute: FigmaRoute;
  confidence: number;
  reasoning: string;
  matchedTemplateId?: string;
  requiresHumanReview: boolean;
}

export class DesignRouter {
  private readonly confidenceThreshold = 0.85;

  resolveRoute(brief: DesignBrief, availableTemplates: Array<{ id: string; category: string; matchScore: number }>): RouteResolution {
    // 1. Check if an exact approved template matches
    const bestTemplate = availableTemplates.sort((a, b) => b.matchScore - a.matchScore)[0];
    if (bestTemplate && bestTemplate.matchScore >= 0.9) {
      return {
        route: 'template_fill',
        figmaRoute: 'buzz_template',
        confidence: bestTemplate.matchScore,
        reasoning: `Matched high-confidence template ${bestTemplate.id}`,
        matchedTemplateId: bestTemplate.id,
        requiresHumanReview: false,
      };
    }

    // 2. Check if complex novel creative request
    const isComplex = brief.objective.toLowerCase().includes('campaign') ||
      brief.objective.toLowerCase().includes('brand launch') ||
      brief.objective.toLowerCase().includes('کەمپین') ||
      brief.objective.toLowerCase().includes('داهێنان');

    if (isComplex) {
      return {
        route: 'creative_director',
        figmaRoute: 'figma_freeform',
        confidence: 0.92,
        reasoning: 'Task classified as complex novel visual campaign, routing to Creative Director Runner',
        requiresHumanReview: false,
      };
    }

    // 3. Check for standard editable composition
    if (brief.exactCopy.length <= 3 && brief.variants.length <= 2) {
      return {
        route: 'editable_composition',
        figmaRoute: 'figma_freeform',
        confidence: 0.88,
        reasoning: 'Routine request with simple copy and standard dimensions',
        requiresHumanReview: false,
      };
    }

    // 4. Ambiguity / low confidence
    return {
      route: 'human_only',
      figmaRoute: 'human',
      confidence: 0.65,
      reasoning: 'Low confidence routing match or highly customized requirement; pauses for human operator selection',
      requiresHumanReview: true,
    };
  }
}
