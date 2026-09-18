import { escapeTelegramHtml } from '@hawa/integrations';
import { resolveModel } from '@hawa/domain';

export type DocumentKind = 'formal_document' | 'design_piece';
export type MessageKind = 'new_brief' | 'feedback' | 'question' | 'other';

export interface MessageClassification {
  kind: MessageKind;
  intent: 'revision_feedback' | 'new_brief' | 'question_or_other';
  confidence: number;
  isInstructionOnly: boolean;
  directive?: string;
  reason: string;
  documentKind?: DocumentKind;
  needsClarification?: boolean;
  clarifyingQuestion?: string;
  callReceipt?: {
    id: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    costUsd?: number;
    requestId?: string;
  };
}

export interface ClassifierOptions {
  apiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const REVISION_KEYWORDS = [
  // Quality / judgment
  'better', 'worse', 'high end', 'professional', 'cheap', 'basic', 'ugly', 'bad', 'great', 'poor',
  'cleaner', 'less boxy', 'too boxy', 'boxy', 'repetitive', 'same design', 'earlier design', 'previous design',
  // Actions
  'change', 'revise', 'revision', 'redo', 'redesign', 'start over', 'try another', 'different',
  'fix', 'adjust', 'update', 'remove', 'add', 'replace', 'swap', 'switch', 'move', 'shift', 'resize',
  // Layout & Visual elements
  'background', 'gradient', 'texture', 'color', 'colour', 'font', 'typography', 'spacing', 'margin',
  'padding', 'column', 'columns', 'grid', 'frame', 'border', 'logo', 'seal', 'title', 'headline',
  'darker', 'lighter', 'brighter', 'contrast', 'gold', 'navy', 'cream', 'blue', 'white',
  // Kurdish keywords
  'دیزاینێکی تر', 'دەستکاری', 'گۆڕانکاری', 'چاککردنەوە', 'جیاواز بێت', 'باشتر بکە',
  'دیزاینی پێشوو', 'ئەوەی پێشتر', 'هەمان دیزاین', 'بگۆڕە', 'بجوڵێنە', 'باگراوند',
  'ڕەنگ', 'فۆنت', 'گەورەتر', 'بچووکتر', 'تۆختر', 'کاڵتر', 'قەبارە'
];

const INSTRUCTION_PATTERNS = [
  /^(the\s+)?background\s+is\b/i,
  /^(i\s+)?want\s+(some\s+kind\s+of|a|more|less)\b/i,
  /^(can\s+you\s+)?make\s+it\b/i,
  /^(please\s+)?(change|adjust|fix|remove|add|replace|update|switch|move)\b/i,
  /^(make\s+it\s+look|looks?\s+(too|really|quite|very)?\s+(basic|cheap|bad|plain|simple|boxy))/i,
  /^(create\s+a\s+new\s+one\s+better|best\s+one\s+u\s+can)/i,
  /^(thats?\s+the\s+same\s+design)/i,
  /^(use\s+a\s+different|try\s+a\s+different|different\s+layout)/i,
  /^(زیاتر|کەمتر|باگراوندەکە|ڕەنگەکە|تکایە\s+بگۆڕە|جیاوازتر)/i,
];

export function isSoraniText(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F]/.test(text);
}

export function detectDocumentKind(text: string): DocumentKind {
  const lower = text.toLowerCase();
  if (
    /\b(letter|certificate|agenda|programme|program|formal paper|decree|resolution|circular|memorandum|statement|statute|report)\b/i.test(lower) ||
    /(بڕوانامە|بەڵگەنامە|بەرنامە|ئەجێندا|بڕیار|ڕاپۆرت|نوسراو|پەیام|مەرسوم)/.test(text)
  ) {
    return 'formal_document';
  }
  return 'design_piece';
}

/**
 * Heuristic classifier used when model call is skipped, fails, or in tests.
 */
export function classifyWithHeuristics(
  text: string,
  hasRecentTask: boolean,
  hasReplyTo: boolean = false
): MessageClassification {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const documentKind = detectDocumentKind(trimmed);

  // Check if text matches instruction-only patterns
  const matchesInstructionPattern = INSTRUCTION_PATTERNS.some((p) => p.test(trimmed));
  const hasRevisionKeyword = REVISION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));

  // Detect whether the incoming message is a full structured brief with event body copy
  const hasMultipleParagraphs = trimmed.split(/\n\s*\n/).filter(Boolean).length >= 2;
  const hasEventIndicators = /\b(date|time|venue|location|hall|auditorium|hotel|rsvp|cordially|invitation|accreditation|ceremony|honour|honor|presidents?|ministers?|ڕۆژ|کات|شوێن|هۆڵ|بانگهێشت)\b/i.test(trimmed);
  const hasDivider = /\n\s*([_\-=\*]{3,})\s*\n/.test(trimmed);
  const hasSectionHeader = /\n\s*(?:content|copy|text|invitation|details|دەق|ناوەڕۆک)\s*:\s*\n?/i.test(trimmed);
  const isFullStructuredBrief = hasDivider || hasSectionHeader || (hasMultipleParagraphs && (hasEventIndicators || trimmed.length > 200));

  // Explicit revision triggers
  const explicitRevisionPattern = /^(?:can\s+you\s+)?(?:make\s+it\b|change\b|adjust\b|fix\b|update\b|redo\b|redesign\b|retry\b|start\s+over\b|try\s+another\b|thats?\s+the\s+same\b|looks?\s+(?:too|really|quite|very)?\s*(?:basic|cheap|bad|plain|simple|boxy)|different\s+(?:font|color|layout)|move\s+the|resize\s+the|swap\s+the|remove\s+the|add\s+a|تکایە\s+بگۆڕە|بگۆڕە|دەستکاری|چاککردنەوە|دیزاینێکی\s+تر|ئەوەی\s+پێشتر|هەمان\s+دیزاین)/i;
  const isExplicitRevision = explicitRevisionPattern.test(trimmed);

  const isInstructionOnly = !isFullStructuredBrief && !hasEventIndicators && (
    matchesInstructionPattern ||
    isExplicitRevision ||
    (trimmed.length < 280 && hasRevisionKeyword)
  );

  // 1. Reply-to always binds to the specific replied-to task
  if (hasReplyTo) {
    return {
      kind: 'feedback',
      intent: 'revision_feedback',
      confidence: 0.95,
      isInstructionOnly,
      directive: trimmed,
      reason: 'User directly replied to a previous task message in chat',
      documentKind,
    };
  }

  // 2. Full structured briefs with complete copy/event details must NEVER be hijacked as revisions
  if (isFullStructuredBrief) {
    return {
      kind: 'new_brief',
      intent: 'new_brief',
      confidence: 0.95,
      isInstructionOnly: false,
      reason: 'Complete design brief with structured copy and event details detected',
      documentKind,
    };
  }

  // 3. Greetings or bot slash-commands
  if (trimmed.startsWith('/') || /^(hi|hello|hey|help|status|سڵاو|چۆنی)\b/i.test(trimmed)) {
    return {
      kind: trimmed.startsWith('/') ? 'question' : 'other',
      intent: 'question_or_other',
      confidence: 0.9,
      isInstructionOnly: false,
      reason: 'Greeting or command detected',
      documentKind,
    };
  }

  // 4. Questions
  if (/\?$|^(when|what|how|where|who|is\s+it|can\s+we|would|ئایا|کەی|چۆن|چی)\b/i.test(trimmed)) {
    return {
      kind: 'question',
      intent: 'question_or_other',
      confidence: 0.88,
      isInstructionOnly: false,
      reason: 'Query or question detected',
      documentKind,
    };
  }

  // 5. Revision directives on recent active task
  if (hasRecentTask && (isExplicitRevision || (hasRevisionKeyword && isInstructionOnly))) {
    return {
      kind: 'feedback',
      intent: 'revision_feedback',
      confidence: 0.85,
      isInstructionOnly,
      directive: trimmed,
      reason: `Explicit revision directive targeting active task: "${trimmed.slice(0, 50)}"`,
      documentKind,
    };
  }

  // 6. Instruction-only text without an active prior task
  if (!hasRecentTask && isInstructionOnly) {
    return {
      kind: 'new_brief',
      intent: 'new_brief',
      confidence: 0.7,
      isInstructionOnly: true,
      reason: 'Instruction-only phrasing detected without active prior task',
      documentKind,
    };
  }

  return {
    kind: 'new_brief',
    intent: 'new_brief',
    confidence: 0.8,
    isInstructionOnly: false,
    reason: 'Standard new design brief text',
    documentKind,
  };
}

/**
 * Classifies an incoming Telegram message using gpt-6-astra strict JSON schema structured output,
 * with optional prior design preview image and schema-guided reasoning.
 */
export async function classifyInboundTelegramMessage(
  input: {
    messageText: string;
    recentTask?: {
      id: string;
      title: string;
      rawText?: string;
      copy?: string[];
      previewImageUrl?: string;
      previewImageBase64?: string;
    } | null;
    hasReplyTo?: boolean;
    hasReferenceImage?: boolean;
  },
  options: ClassifierOptions = {}
): Promise<MessageClassification> {
  const { messageText, recentTask, hasReplyTo } = input;
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  const fetcher = options.fetcher || fetch;
  const timeoutMs = options.timeoutMs || 10000;

  // If no OpenAI key or in offline test environment without mock fetcher, use heuristics
  if (!apiKey || (process.env.NODE_ENV === 'test' && !options.fetcher && !process.env.VITEST_REAL_AI)) {
    return classifyWithHeuristics(messageText, Boolean(recentTask), hasReplyTo);
  }

  // If user explicitly replied to a message, strongly weight towards revision
  if (hasReplyTo && recentTask) {
    return classifyWithHeuristics(messageText, true, true);
  }

  // If there is no recent task in the chat, use heuristics for fast routing
  if (!recentTask) {
    return classifyWithHeuristics(messageText, false, false);
  }

  try {
    const previewImg = recentTask.previewImageUrl || recentTask.previewImageBase64;
    const userPromptText = `You are evaluating an incoming client message in a Telegram chat where a prior design task exists.

Active Prior Task in Chat:
- ID: ${recentTask.id}
- Title: ${recentTask.title}
- Previous Content/Copy: ${recentTask.rawText || (recentTask.copy ? recentTask.copy.join('; ') : 'None')}
${previewImg ? '- Last Draft Preview Image: (Attached as an image for your reference)' : ''}

Incoming Client Message:
"${messageText}"

Decide the exact kind of message:
- "new_brief": The client is submitting text or details for a NEW design (e.g. an invitation, announcement, certificate, poster, or card). CRITICAL RULE: If the message contains complete body copy, announcement details, dates, venues, or dividers with text to be placed on a design, it is ALWAYS "new_brief", even if it mentions styling preferences. NEVER classify a message with complete event copy or announcement body text as "feedback".
- "feedback": The client is critiquing, requesting changes, or giving directives to alter the existing design (e.g. "make it more modern", "change the colors", "too boxy", "move the date", "can we use another font", "gradient or texture", or Kurdish "دەستکاری بکە", "ڕەنگەکەی بگۆڕە").
- "question": The client is asking a question (e.g. status, cost, format, capabilities).
- "other": Greetings, acknowledgments ("thanks", "ok"), or unrelated chatter.`;

    const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: userPromptText },
    ];

    if (previewImg) {
      const cleanImg = previewImg.replace(/\s+/g, '');
      const url = cleanImg.startsWith('data:') || cleanImg.startsWith('http')
        ? cleanImg
        : `data:image/png;base64,${cleanImg}`;
      userContent.push({
        type: 'image_url',
        image_url: { url },
      });
    }

    const res = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolveModel('text'),
        messages: [
          {
            role: 'system',
            content: 'You are an elite creative design intake classifier for Hawa Creative OS. You evaluate client messages in Telegram chats and accurately distinguish new design briefs from revision feedback on previous designs. Output strictly valid JSON matching the schema.',
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'telegram_classifier',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['new_brief', 'feedback', 'question', 'other'],
                  description: "The classified intent: 'new_brief', 'feedback', 'question', or 'other'.",
                },
                confidence: {
                  type: 'number',
                  description: 'Confidence score from 0.0 to 1.0.',
                },
                reason: {
                  type: 'string',
                  description: 'Concise explanation for the decision.',
                },
                isInstructionOnly: {
                  type: 'boolean',
                  description: 'True if message contains only instructions or styling critique without any factual event copy or body text.',
                },
                documentKind: {
                  type: 'string',
                  enum: ['formal_document', 'design_piece'],
                  description: "'formal_document' for letters/certificates/agendas; 'design_piece' for invitations/posters/social graphics.",
                },
                directive: {
                  type: 'string',
                  description: 'The extracted revision directive or empty string if none.',
                },
              },
              required: ['kind', 'confidence', 'reason', 'isInstructionOnly', 'documentKind', 'directive'],
              additionalProperties: false,
            },
          },
        },
        max_completion_tokens: 300,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return classifyWithHeuristics(messageText, true, hasReplyTo);
    }

    const requestId = res.headers.get('x-request-id') || undefined;
    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return classifyWithHeuristics(messageText, true, hasReplyTo);
    }

    const parsed = JSON.parse(content);
    const rawKind = parsed.kind || (parsed.intent === 'revision_feedback' ? 'feedback' : (parsed.intent === 'question_or_other' ? 'question' : parsed.intent));
    const kind: MessageKind = ['new_brief', 'feedback', 'question', 'other'].includes(rawKind)
      ? rawKind
      : 'new_brief';

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.9;
    const isInstructionOnly = Boolean(parsed.isInstructionOnly);
    const directive = parsed.directive || messageText.trim();
    const reason = parsed.reason || 'Classified by gpt-6-astra';
    const docKind = parsed.documentKind === 'formal_document' ? 'formal_document' : 'design_piece';

    const intent = kind === 'feedback'
      ? 'revision_feedback'
      : kind === 'new_brief'
      ? 'new_brief'
      : 'question_or_other';

    const needsClarification = confidence < 0.75;
    let clarifyingQuestion: string | undefined;
    if (needsClarification) {
      clarifyingQuestion = isSoraniText(messageText)
        ? 'تکایە ڕوونکردنەوە بدە: ئایا دەتەوێت دیزاینەکەی پێشوو دەستکاری بکەیت، یان دەتەوێت دیزاینێکی نوێ بە دەقی نوێوە دروست بکەیت؟'
        : 'Could you please clarify: would you like to revise the previous design with these changes, or create a brand new design with new text?';
    }

    return {
      kind,
      intent,
      confidence,
      isInstructionOnly,
      directive,
      reason,
      documentKind: docKind,
      needsClarification,
      clarifyingQuestion,
      callReceipt: {
        id: data.id || `chatcmpl_${Date.now()}`,
        model: data.model || resolveModel('text'),
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
        requestId,
      },
    };
  } catch (err) {
    // Fallback to heuristics on network or timeout error
  }

  return classifyWithHeuristics(messageText, true, hasReplyTo);
}
