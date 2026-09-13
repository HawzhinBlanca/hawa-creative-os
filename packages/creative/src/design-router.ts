import type { DesignBrief } from '@hawa/domain';

export type TaskRoute =
  | 'template_fill'
  | 'editable_composition'
  | 'creative_director'
  | 'multi_format_composition'
  | 'human_only';

export type StudioRoute = 'canva_template' | 'canva_composition' | 'human';

import type { CanonicalFormat } from './creative-director.js';

export interface RouteResolution {
  route: TaskRoute;
  studioRoute: StudioRoute;
  confidence: number;
  reasoning: string;
  matchedTemplateId?: string;
  requiresHumanReview: boolean;
  detectedFormats?: CanonicalFormat[];
}

export class DesignRouter {
  private readonly confidenceThreshold = 0.85;

  /**
   * Detects requested canonical formats from brief variants and natural language context.
   */
  detectRequestedFormats(brief: DesignBrief): CanonicalFormat[] {
    const formats = new Set<CanonicalFormat>();

    // 1. Inspect explicit variants
    for (const v of brief.variants || []) {
      const name = (v.name || '').toLowerCase();
      const role = (v.role || '').toLowerCase();
      const ratio = (v.aspectRatio || '').toLowerCase();

      if (v.width === 1080 && v.height === 1350 || ratio === '4:5' || name.includes('feed') || role.includes('post')) {
        formats.add('feed');
      } else if (v.width === 1080 && v.height === 1920 || ratio === '9:16' || name.includes('story') || role.includes('story')) {
        formats.add('story');
      } else if (v.width === 1920 && v.height === 1080 || ratio === '16:9' || name.includes('landscape') || name.includes('horizontal') || role.includes('banner')) {
        formats.add('landscape');
      } else if (v.width === 2480 && v.height === 3508 || ratio === '1:1.414' || name.includes('a4') || name.includes('print')) {
        formats.add('print_a4');
      } else if (v.width === 1080 && v.height === 1080) {
        formats.add('feed'); // 1:1 maps gracefully to feed format family
      }
    }

    // 2. Inspect objective and copy for natural language format requests
    const objLower = (brief.objective || '').toLowerCase();
    const copyText = (brief.exactCopy || []).map((c) => c.text.toLowerCase()).join(' ');
    const combined = `${objLower} ${copyText}`;

    if (
      combined.includes('omnichannel') ||
      combined.includes('multi-format') ||
      combined.includes('multiformat') ||
      combined.includes('all formats') ||
      combined.includes('سەرجەم قەبارەکان') ||
      combined.includes('هەموو قەبارەکان') ||
      combined.includes('چوار قەبارە')
    ) {
      return ['feed', 'story', 'landscape', 'print_a4'];
    }

    if (combined.includes('story') || combined.includes('ستۆری')) formats.add('story');
    if (combined.includes('feed') || combined.includes('پۆست') || combined.includes('social card')) formats.add('feed');
    if (combined.includes('landscape') || combined.includes('horizontal') || combined.includes('پانۆراما') || combined.includes('ئاسۆیی')) formats.add('landscape');
    if (combined.includes('print') || combined.includes('a4') || combined.includes('چاپ')) formats.add('print_a4');

    if (formats.size === 0) {
      formats.add('feed');
    }

    return Array.from(formats);
  }

  resolveRoute(
    brief: DesignBrief,
    availableTemplates: Array<{ id: string; category: string; matchScore: number }>
  ): RouteResolution {
    const detectedFormats = this.detectRequestedFormats(brief);

    // 0. Explicit multi-format request or multi-variant omnichannel campaign
    const objLower = (brief.objective || '').toLowerCase();
    const copyText = (brief.exactCopy || []).map((c) => c.text.toLowerCase()).join(' ');
    const combined = `${objLower} ${copyText}`;

    const isExplicitMultiFormat =
      brief.taskRoute === 'multi_format_composition' ||
      detectedFormats.length >= 3 ||
      brief.variants.length >= 3 ||
      combined.includes('omnichannel') ||
      combined.includes('multi-format') ||
      combined.includes('multiformat') ||
      combined.includes('all formats') ||
      combined.includes('print and social') ||
      combined.includes('سەرجەم قەبارەکان') ||
      combined.includes('هەموو قەبارەکان');

    if (isExplicitMultiFormat) {
      return {
        route: 'multi_format_composition',
        studioRoute: 'canva_composition',
        confidence: 0.96,
        reasoning: `Omnichannel multi-format request detected across ${detectedFormats.length} canonical formats (${detectedFormats.join(', ')})`,
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    // 1. Check if an exact approved template matches
    const bestTemplate = availableTemplates.sort((a, b) => b.matchScore - a.matchScore)[0];
    if (bestTemplate && bestTemplate.matchScore >= 0.9) {
      return {
        route: 'template_fill',
        studioRoute: 'canva_template',
        confidence: bestTemplate.matchScore,
        reasoning: `Matched high-confidence template ${bestTemplate.id}`,
        matchedTemplateId: bestTemplate.id,
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    // 1b. Check KAAE Institutional Archetypes
    if (
      combined.includes('eligibility') ||
      combined.includes('decree') ||
      combined.includes('auk') ||
      combined.includes('cue') ||
      combined.includes('شیاوبوون') ||
      combined.includes('بڕیار')
    ) {
      return {
        route: 'template_fill',
        studioRoute: 'canva_template',
        confidence: 0.98,
        reasoning: 'Direct match for KAAE University Eligibility Status Decree Archetype',
        matchedTemplateId: 'kaae_eligibility_decree',
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    if (
      combined.includes('milestone') ||
      combined.includes('chea') ||
      combined.includes('inqaahe') ||
      combined.includes('unesco') ||
      combined.includes('دەستکەوت')
    ) {
      return {
        route: 'template_fill',
        studioRoute: 'canva_template',
        confidence: 0.98,
        reasoning: 'Direct match for KAAE Global Quality Milestone Archetype',
        matchedTemplateId: 'kaae_global_milestone',
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    if (
      combined.includes('evaluator') ||
      combined.includes('peer review') ||
      combined.includes('هەڵسەنگێنەر') ||
      combined.includes('بانگەواز')
    ) {
      return {
        route: 'template_fill',
        studioRoute: 'canva_template',
        confidence: 0.98,
        reasoning: 'Direct match for KAAE Call for Peer Evaluators Archetype',
        matchedTemplateId: 'kaae_evaluator_call',
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    if (
      combined.includes('metric') ||
      combined.includes('analytics') ||
      combined.includes('reach') ||
      combined.includes('views') ||
      combined.includes('ئامار')
    ) {
      return {
        route: 'template_fill',
        studioRoute: 'canva_template',
        confidence: 0.98,
        reasoning: 'Direct match for KAAE Analytics & Reach Metrics Card Archetype',
        matchedTemplateId: 'kaae_metrics_card',
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    // 2. Check if complex novel creative request
    const isComplex =
      brief.objective.toLowerCase().includes('campaign') ||
      brief.objective.toLowerCase().includes('brand launch') ||
      brief.objective.toLowerCase().includes('کەمپین') ||
      brief.objective.toLowerCase().includes('داهێنان');

    if (isComplex) {
      return {
        route: 'creative_director',
        studioRoute: 'canva_composition',
        confidence: 0.92,
        reasoning: 'Task classified as complex novel visual campaign, routing to Creative Director Runner',
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    // 3. Check for standard editable composition
    if (brief.exactCopy.length <= 3 && brief.variants.length <= 2) {
      return {
        route: 'editable_composition',
        studioRoute: 'canva_composition',
        confidence: 0.88,
        reasoning: 'Routine request with simple copy and standard dimensions',
        requiresHumanReview: false,
        detectedFormats,
      };
    }

    // 4. Ambiguity / low confidence
    return {
      route: 'human_only',
      studioRoute: 'human',
      confidence: 0.65,
      reasoning: 'Low confidence routing match or highly customized requirement; pauses for human operator selection',
      requiresHumanReview: true,
      detectedFormats,
    };
  }
}
