import { escapeTelegramHtml } from '@hawa/integrations';

export interface MessageClassification {
  intent: 'revision_feedback' | 'new_brief' | 'question_or_other';
  confidence: number;
  isInstructionOnly: boolean;
  directive?: string;
  reason: string;
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

  // Check if text matches instruction-only patterns
  const matchesInstructionPattern = INSTRUCTION_PATTERNS.some((p) => p.test(trimmed));
  const hasRevisionKeyword = REVISION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));

  // Long texts with structured lines or multiple paragraphs with dates/locations are usually new briefs
  const hasMultipleParagraphs = trimmed.split(/\n\s*\n/).filter(Boolean).length >= 2;
  const hasEventIndicators = /\b(date|time|venue|location|hall|auditorium|hotel|rsvp|cordially|invitation|ڕۆژ|کات|شوێن|هۆڵ)\b/i.test(trimmed);

  const isInstructionOnly = matchesInstructionPattern || (
    !hasMultipleParagraphs &&
    !hasEventIndicators &&
    trimmed.length < 280 &&
    hasRevisionKeyword
  );

  if (hasReplyTo) {
    return {
      intent: 'revision_feedback',
      confidence: 0.95,
      isInstructionOnly,
      directive: trimmed,
      reason: 'User directly replied to a previous task message in chat',
    };
  }

  if (hasRecentTask && (hasRevisionKeyword || matchesInstructionPattern)) {
    return {
      intent: 'revision_feedback',
      confidence: 0.85,
      isInstructionOnly,
      directive: trimmed,
      reason: `Matched revision keyword or instruction pattern with active task in chat: "${trimmed.slice(0, 50)}"`,
    };
  }

  if (!hasRecentTask && isInstructionOnly) {
    return {
      intent: 'new_brief',
      confidence: 0.7,
      isInstructionOnly: true,
      reason: 'Instruction-only phrasing detected without active prior task',
    };
  }

  if (trimmed.startsWith('/') || /^(hi|hello|hey|help|status|سڵاو|چۆنی)\b/i.test(trimmed)) {
    return {
      intent: 'question_or_other',
      confidence: 0.9,
      isInstructionOnly: false,
      reason: 'Greeting or command detected',
    };
  }

  return {
    intent: 'new_brief',
    confidence: 0.8,
    isInstructionOnly: false,
    reason: 'Standard new design brief text',
  };
}

/**
 * Classifies an incoming Telegram message using gpt-6-astra structured JSON output,
 * with resilient heuristic fallback.
 */
export async function classifyInboundTelegramMessage(
  input: {
    messageText: string;
    recentTask?: {
      id: string;
      title: string;
      rawText?: string;
      copy?: string[];
    } | null;
    hasReplyTo?: boolean;
    hasReferenceImage?: boolean;
  },
  options: ClassifierOptions = {}
): Promise<MessageClassification> {
  const { messageText, recentTask, hasReplyTo, hasReferenceImage } = input;
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  const fetcher = options.fetcher || fetch;
  const timeoutMs = options.timeoutMs || 8000;

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
    const prompt = `You are an elite design intake classifier for Hawa Creative OS.
A client sent a new message in a Telegram chat that already has an active design task.

Active Prior Task in Chat:
- ID: ${recentTask.id}
- Title: ${recentTask.title}
- Previous Content/Copy: ${recentTask.rawText || (recentTask.copy ? recentTask.copy.join('; ') : 'None')}

Incoming Client Message:
"${messageText}"

Decide:
1. "intent":
   - "revision_feedback": The client is critiquing, requesting alterations, asking for improvements, or giving directives on the design (e.g. "make it better", "looks basic", "change the background", "the background is simple and solid, i want a gradient or texture", "thats the same design again", "different font", "move the logo").
   - "new_brief": The client is sending a brand-new design request with new text/copy for a different event or publication.
   - "question_or_other": A question, greeting, or irrelevant chatter.
2. "isInstructionOnly": true if the incoming message contains ONLY design styling instructions, critique, or preferences, and lacks actual body copy/facts/names/dates for an invitation or post.
3. "directive": The extracted styling or revision directive.
4. "confidence": A score between 0.0 and 1.0.
5. "reason": A brief 1-sentence justification.

Output strictly JSON adhering to the schema:
{"intent": "revision_feedback"|"new_brief"|"question_or_other", "isInstructionOnly": boolean, "confidence": number, "directive": string, "reason": string}`;

    const res = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        messages: [
          { role: 'system', content: 'You are an accurate intent classification engine. Output only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return classifyWithHeuristics(messageText, true, hasReplyTo);
    }

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return classifyWithHeuristics(messageText, true, hasReplyTo);
    }

    const parsed = JSON.parse(content);
    if (['revision_feedback', 'new_brief', 'question_or_other'].includes(parsed.intent)) {
      return {
        intent: parsed.intent,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.9,
        isInstructionOnly: Boolean(parsed.isInstructionOnly),
        directive: parsed.directive || messageText.trim(),
        reason: parsed.reason || 'Classified by gpt-6-astra',
      };
    }
  } catch (err) {
    // Graceful fallback to heuristics on any network or parsing error
  }

  return classifyWithHeuristics(messageText, true, hasReplyTo);
}
