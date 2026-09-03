import type { UUID, ISODateTime, Result, AppError } from '@hawa/contracts';

export interface ProtectedToken {
  type: 'price' | 'date' | 'time' | 'phone' | 'address' | 'url' | 'hashtag' | 'code' | 'name';
  raw: string;
  normalized: string;
  mustPreserveExact: boolean;
}

export interface ExactCopyBlock {
  id: string;
  role: 'headline' | 'subheadline' | 'body' | 'cta' | 'disclaimer' | 'badge';
  text: string;
  language: 'ckb' | 'ar' | 'en' | string;
  direction: 'rtl' | 'ltr';
  approved: boolean;
  protectedTokens: ProtectedToken[];
}

export interface MissingFact {
  field: string;
  question: string;
  impact: 'critical' | 'high' | 'medium';
  blocking: boolean;
}

export interface DesignVariant {
  id: string;
  name: string;
  width: number;
  height: number;
  aspectRatio: string;
  role: 'instagram_post' | 'instagram_story' | 'billboard' | 'banner' | 'custom';
}

export interface DesignBrief {
  briefId: UUID;
  taskId: UUID;
  clientId: UUID;
  projectId?: UUID;
  clientDnaVersion: number;
  objective: string;
  taskRoute: 'template_fill' | 'editable_composition' | 'creative_director' | 'human_only';
  primaryLanguage: string;
  direction: 'rtl' | 'ltr';
  variants: DesignVariant[];
  exactCopy: ExactCopyBlock[];
  missingFacts: MissingFact[];
  requiredAssetRoles: string[];
  styleFamily?: string;
  modelSuggestions?: Array<{ role: string; text: string; confidence: number }>;
  createdAt: ISODateTime;
}

export function validateBrief(brief: DesignBrief): Result<DesignBrief, AppError> {
  const blockingFacts = brief.missingFacts.filter((f) => f.blocking);
  if (blockingFacts.length > 0) {
    return {
      ok: false,
      error: {
        code: 'BRIEF_HAS_MISSING_FACTS',
        message: `Brief cannot proceed: ${blockingFacts.length} missing fact(s) detected (${blockingFacts.map((f) => f.field).join(', ')})`,
        retryable: false,
        safeAction: 'Transition task to NEEDS_INFORMATION and query user',
        detail: { missingFacts: blockingFacts },
      },
    };
  }

  if (brief.exactCopy.length === 0) {
    return {
      ok: false,
      error: {
        code: 'EMPTY_EXACT_COPY',
        message: 'Design Brief requires at least one exact copy block',
        retryable: false,
        safeAction: 'Add approved copy or headline to brief',
      },
    };
  }

  if (brief.variants.length === 0) {
    return {
      ok: false,
      error: {
        code: 'NO_VARIANTS_SPECIFIED',
        message: 'Design Brief must define at least one canvas variant with width and height',
        retryable: false,
        safeAction: 'Specify target canvas dimensions',
      },
    };
  }

  return { ok: true, value: brief };
}

export function extractProtectedTokens(text: string): ProtectedToken[] {
  const tokens: ProtectedToken[] = [];

  // Price patterns (e.g. $10, 10,000 IQD, 15$, 25,000 د.ع, ٢٥٬٠٠٠ دینار)
  const priceRegex = /(\$\s*[\d\u0660-\u0669\u06F0-\u06F9]+(?:[.,٬][\d\u0660-\u0669\u06F0-\u06F9]+)?|[\d\u0660-\u0669\u06F0-\u06F9]+(?:[.,٬][\d\u0660-\u0669\u06F0-\u06F9]+)?\s*(?:\$|IQD|USD|د\.ع|دینار|هەزار))/gi;
  let match: RegExpExecArray | null;
  while ((match = priceRegex.exec(text)) !== null) {
    tokens.push({
      type: 'price',
      raw: match[0].trim(),
      normalized: match[0].trim().replace(/\s+/g, ' '),
      mustPreserveExact: true,
    });
  }

  // URL patterns
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.(?:com|org|net|iq|krd)[^\s]*)/gi;
  while ((match = urlRegex.exec(text)) !== null) {
    tokens.push({
      type: 'url',
      raw: match[0].trim(),
      normalized: match[0].trim().toLowerCase(),
      mustPreserveExact: true,
    });
  }

  // Phone numbers (e.g. +964 750 123 4567, 07501234567)
  const phoneRegex = /(?:\+?964|0)?\s*7[5789]\d(?:\s*|\-?)\d{3}(?:\s*|\-?)\d{4}/g;
  while ((match = phoneRegex.exec(text)) !== null) {
    tokens.push({
      type: 'phone',
      raw: match[0].trim(),
      normalized: match[0].trim().replace(/[\s\-]/g, ''),
      mustPreserveExact: true,
    });
  }

  return tokens;
}
