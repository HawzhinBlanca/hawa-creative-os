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
  const seenRaws = new Set<string>();

  const addToken = (type: ProtectedToken['type'], raw: string, normalized?: string) => {
    const trimmed = raw.trim();
    if (!trimmed || seenRaws.has(trimmed)) return;
    seenRaws.add(trimmed);
    tokens.push({
      type,
      raw: trimmed,
      normalized: normalized ?? trimmed.replace(/\s+/g, ' '),
      mustPreserveExact: true,
    });
  };

  // Price patterns (e.g. $10, 10,000 IQD, 15$, 25,000 د.ع, ٢٥٬٠٠٠ دینار, 50€, 100 EUR, ٪٢٥, %20)
  const priceRegex = /((?:\$|€|%|٪)\s*[\d\u0660-\u0669\u06F0-\u06F9]+(?:[.,٬][\d\u0660-\u0669\u06F0-\u06F9]+)?|[\d\u0660-\u0669\u06F0-\u06F9]+(?:[.,٬][\d\u0660-\u0669\u06F0-\u06F9]+)?\s*(?:\$|€|IQD|USD|EUR|د\.ع|دینار|هەزار|لیرە|%|٪))/gi;
  let match: RegExpExecArray | null;
  while ((match = priceRegex.exec(text)) !== null) {
    addToken('price', match[0]);
  }

  // Email patterns
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  while ((match = emailRegex.exec(text)) !== null) {
    addToken('url', match[0], match[0].toLowerCase());
  }

  // URL patterns
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.(?:com|org|net|iq|krd|io|me)[^\s]*)/gi;
  while ((match = urlRegex.exec(text)) !== null) {
    addToken('url', match[0], match[0].toLowerCase());
  }

  // Phone numbers (e.g. +964 750 123 4567, 07501234567, ٠٧٥٠١٢٣٤٥٦٧, 0770 123 4567)
  const phoneRegex = /(?:\+?964|00964|0|[\u0660\u06F0])?\s*(?:7|[\u0667\u06F7])[5789\u0665\u0667\u0668\u0669\u06F5\u06F7\u06F8\u06F9][\d\u0660-\u0669\u06F0-\u06F9](?:\s*|\-?)[\d\u0660-\u0669\u06F0-\u06F9]{3}(?:\s*|\-?)[\d\u0660-\u0669\u06F0-\u06F9]{4}/g;
  while ((match = phoneRegex.exec(text)) !== null) {
    addToken('phone', match[0], match[0].replace(/[\s\-]/g, ''));
  }

  // Hashtags (e.g. #هاوین٢٠٢٦, #عروض_الصيف, #Hawdesign)
  const hashtagRegex = /(#[a-zA-Z0-9_\u0600-\u06FF\u0750-\u077F]+)/g;
  while ((match = hashtagRegex.exec(text)) !== null) {
    addToken('hashtag', match[0]);
  }

  // Date patterns (e.g. 2026/09/04, 2026-09-04, 04.09.2026, ٢٠٢٦/٠٩/٠٤)
  const dateRegex = /([\d\u0660-\u0669\u06F0-\u06F9]{4}[-/.\u060D][\d\u0660-\u0669\u06F0-\u06F9]{1,2}[-/.\u060D][\d\u0660-\u0669\u06F0-\u06F9]{1,2}|[\d\u0660-\u0669\u06F0-\u06F9]{1,2}[-/.\u060D][\d\u0660-\u0669\u06F0-\u06F9]{1,2}[-/.\u060D][\d\u0660-\u0669\u06F0-\u06F9]{4})/g;
  while ((match = dateRegex.exec(text)) !== null) {
    addToken('date', match[0]);
  }

  return tokens;
}
