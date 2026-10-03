import { officeReviewUrl } from './desk-review-link.js';
import { persistChatIntake, type ChatIntake } from './chat-intake.js';
import { isCopyIntroducer, peelTrailingRemarks } from './request-remarks.js';
import { log } from '../logging.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { type RequestContext, type StudioOperation, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { type DesignBrief, type ExactCopyBlock } from '@hawa/domain';
import { withRlsContext, toApiTaskStatus, sql } from '@hawa/db';
import { normalizeKurdishIncomingText, type CostReceipt, KAAE_CLIENT_ID, escapeTelegramHtml, neutralRequestTitle } from '@hawa/integrations';
import { isWeakBriefLine } from './requester-turn.js';
import { clientNamesFor, copyBesideRequest, requestSpans, speaksToTheDesigner } from './request-copy-extraction.js';
import { unwrapCopyEnvelope } from './canva-design-planner.js';
import { autoDraftAllowedFor, clientPackOf, matchRequestClient, positiveClientWords } from './client-packs.js';
import { defaultCanvasFor } from '@hawa/creative';
import { isValidUuid, inlineTemplateCopyMissing } from '../core-helpers.js';
import { requestTitle } from './request-title.js';
import { isGreetingOnly } from './greetings.js';
import { DEFAULT_TENANT_ID, DEFAULT_CLIENT_ID } from '../core-context.js';
import type { CoreContext } from '../core-context.js';

/**
 * Saves a chat request (Telegram or WhatsApp) as a task and starts its design (architecture programme 1.3, G8).
 * Moved from createApp unchanged; the Telegram webhook and POST /webhooks/whatsapp both call it.
 */
export function createChatCampaignIntake(ctx: CoreContext): ChatCampaignIntake {
  // One per app context: app.ts (the Telegram code) and the WhatsApp routes both ask for it, and whatever
  // state it keeps later (an in-flight dedup, say) must be shared by both.
  const existing = intakes.get(ctx);
  if (existing) return existing;
  const intake = buildChatCampaignIntake(ctx);
  intakes.set(ctx, intake);
  return intake;
}

export { isCopyIntroducer };

/**
 * Hunt 3 (2026-10-03): the closing words of a laid-out brief that speak to the designer: a last paragraph ("Regards,
 * Ahmed", "Don't forget the logo, and please send it to me by Thursday."), a last line ("Keep it simple."), or a
 * last sentence ("… Family Mall. Thanks!"). They were printed as the design's copy (only remarks about attachments
 * were known). Closing words to the event's audience ("Join us!") stay; the brief's first line always stays.
 *
 * Live 2026-10-03 (deploy 1e6881ac, canary chat): the sentence that asks for the design is never peeled. It
 * speaks to the designer too, so "Hi! Could you make a poster for Peer Review Week on 20 October … ? Don't
 * forget the logo. Thanks" lost its request sentence, event and all, and was titled and printed "Hi!". The
 * request sentence stays for the copy extraction, which takes the request words and the greeting out of it.
 */
export function peelClosingInstructions(text: string): { copy: string; remarks: string } {
  let copy = text.trim();
  const remarks: string[] = [];
  const asksForTheDesign = (said: string) => requestSpans(said.replace(/\s*\n\s*/g, ' ')).length > 0;
  const peel = (kept: string, said: string) => { remarks.unshift(said.trim()); copy = kept.trim(); };
  for (let guard = 0; guard < 20; guard++) {
    const paragraphs = copy.split(/\n\s*\n/);
    if (paragraphs.length > 1 && speaksToTheDesigner(paragraphs.at(-1)!.replace(/\s*\n\s*/g, ' ')) && !asksForTheDesign(paragraphs.at(-1)!)) {
      peel(paragraphs.slice(0, -1).join('\n\n'), paragraphs.at(-1)!);
      continue;
    }
    const lines = copy.split('\n');
    if (lines.length > 1 && lines.at(-1)!.trim() && speaksToTheDesigner(lines.at(-1)!) && !asksForTheDesign(lines.at(-1)!)) {
      peel(lines.slice(0, -1).join('\n'), lines.at(-1)!);
      continue;
    }
    const last = lines.at(-1)!;
    const sentences = last.split(/(?<=[.!?؟])\s+(?=\S)/u);
    if (sentences.length > 1 && speaksToTheDesigner(sentences.at(-1)!) && !asksForTheDesign(sentences.at(-1)!)) {
      peel([...lines.slice(0, -1), sentences.slice(0, -1).join(' ')].join('\n'), sentences.at(-1)!);
      continue;
    }
    break;
  }
  return { copy, remarks: remarks.join('\n') };
}

/**
 * The first line that introduces the copy, with the instructions above it and the copy below it.
 * None when no line does, or when nothing follows it (a request without copy stays one).
 */
function splitAtCopyIntroducer(text: string): { instructions: string; introducer: string; copy: string } | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => isCopyIntroducer(line));
  if (at < 0) return null;
  const copy = lines.slice(at + 1).join('\n').trim();
  if (!copy) return null;
  return { instructions: lines.slice(0, at).join('\n').trim(), introducer: lines[at].trim(), copy };
}

type ChatCampaignIntake = ReturnType<typeof buildChatCampaignIntake>;
const intakes = new WeakMap<CoreContext, ChatCampaignIntake>();

function buildChatCampaignIntake(ctx: CoreContext) {
  const {
    briefs,
    broadcastTransition,
    creativeDirector,
    db,
    events,
    isProduction,
    resolveClientDna,
    tasks,
    broadcastEvent: broadcast,
  } = ctx;
  // createApp always builds the bridge; the shared context types it as optional.
  const telegramBridge = ctx.telegramBridge ?? (() => { throw new Error('Chat intake needs the Telegram bridge'); })();
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Autonomous Inbound Chat Ingress & Vector Composition Engine (Invariants #1, #2, #4, #8, #10)
  async function doIngestChatCampaignTask(input: {
    platform: 'telegram' | 'whatsapp';
    sourceEventId: string;
    sourceChannelId: string;
    senderName: string;
    rawText: string;
    voiceTranscript?: string;
    referenceImageBase64?: string;
    explicitClientId?: string | null;
    /** Core's source-derived format, fixed before retrieval. Never read from rawJson. */
    variantOverride?: { width: number; height: number };
    autoGenerate?: boolean;
    rawJson?: any;
    deskBaseUrl?: string;
    isInstructionOnly?: boolean;
  }, prepareOnly = false) {
    const { platform, sourceEventId, sourceChannelId, senderName, rawText, voiceTranscript, referenceImageBase64, explicitClientId, autoGenerate: autoGenerateRequested, deskBaseUrl, isInstructionOnly } = input;
    const normalizedText = normalizeKurdishIncomingText(rawText);

    // 1. Client Routing & Lock (Invariant #4)
    let clientId = explicitClientId || null;
    // Client packs first (ADR-127): the chat's bound client, else the one client its words name. A
    // message naming two pack clients is left for the office to assign, and never guessed.
    let clientAmbiguous = false;
    // ADR-182: an organisation the words say it is NOT for ("This one is for Nova, not KAAE", "instead
    // of KAAE", Sorani "not KAAE") names no client: it opened for KAAE and was drafted in KAAE's brand.
    const namedText = positiveClientWords(rawText);
    const namedNormalized = positiveClientWords(normalizedText);
    if (!clientId) {
      const packMatch = matchRequestClient({ chatId: sourceChannelId, rawText: namedText, normalizedText: namedNormalized });
      if (packMatch.kind === 'chat' || packMatch.kind === 'named') clientId = packMatch.pack.id;
      else if (packMatch.kind === 'ambiguous') {
        clientAmbiguous = true;
        log.info(`[intake] The message names ${packMatch.packs.map((p) => p.code).join(' and ')}; left for the office to assign.`);
      }
    }
    if (!clientId && !clientAmbiguous) {
      const lower = namedText.toLowerCase();
      // Latin brand keywords match whole words only ('faster' is not FastPay, 'corona' is not Rona).
      // The left edge is a Unicode letter class rather than \b, which counts only ASCII word
      // characters and so reported a boundary wherever Kurdish script ran into Latin: a brand name
      // welded into the middle of a Kurdish word matched. The right edge stays ASCII on purpose,
      // because Sorani attaches its suffixes to the word ("KAAEی" is still KAAE).
      const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${w}(?![A-Za-z0-9_])`, 'u').test(lower);
      // A Kurdish brand name is a whole word as well, which may carry a common Sorani suffix. Common
      // words used to name clients: "پارەدان" (payment) named FastPay, "دەرمان" (medicine) and
      // "ڤیتامین" named Drustee, and "دروستی", Drustee's name in Kurdish, was matched inside
      // "تەندروستی" (health). A Ministry of Health request became Drustee's and was drafted for it
      // (review of 2026-09-24). "دروستی" is also the verb "make it" ("دروستی بکە") and the adverb
      // "correctly" ("بە دروستی"), which are not the brand either.
      const kword = (w: string, notAround = '') =>
        new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${w}(?:ی|یە|ە|یش|ەکان|کان)?(?![\\p{L}\\p{N}\\p{M}_])${notAround}`, 'u').test(namedNormalized);
      const drusteeName = kword('(?<!بە\\s+)دروستی', '(?!\\s+(?:بکە|بکر|دەکە|دەکر|کرد))');
      if (
        word('kaae') ||
        namedText.includes('باوەڕپێدان') ||
        namedText.includes('کەی ئەی') ||
        word('accreditation') ||
        word('university') ||
        namedText.includes('زانکۆ')
      ) {
        clientId = KAAE_CLIENT_ID;
      } else if (word('fastpay') || kword('فاستپەی')) {
        clientId = 'client-fastpay';
      } else if (word('aster') || kword('ئاستەر') || kword('ئاستێر')) {
        clientId = 'client-aster';
      } else if (word('drustee') || drusteeName) {
        clientId = 'client-drustee';
      } else if (word('nova') || kword('نۆڤا')) {
        clientId = 'client-nova';
      } else if (word('rona') || kword('ڕۆنا')) {
        clientId = 'client-rona';
      }

      // Fallback: Only inherit client for revision directives, never guess for a fresh brief (Invariant #4).
      // Unscoped requests wait for the art director to assign the client in Hawa Desk.
      const isUnscopedRequest = /\b(new client|unscoped|unknown client|no client|different client|another client|client:\s*none|client:\s*new|client:\s*unassigned)\b/i.test(rawText);
      if (!clientId && !isUnscopedRequest && isInstructionOnly && sourceChannelId && sourceChannelId !== 'tg_default' && db) {
        try {
          const recentClient = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT t.client_id
              FROM hawa.tasks t
              JOIN hawa.outbox_commands o ON o.aggregate_id = t.id
              WHERE o.payload->>'sourceChannelId' = ${sourceChannelId}
                AND t.created_at > now() - interval '48 hours'
                AND t.client_id IS NOT NULL
              ORDER BY t.created_at DESC LIMIT 1`.execute(trx);
          });
          if (recentClient.rows[0]?.client_id) {
            clientId = recentClient.rows[0].client_id;
          }
        } catch (err) {
          log.warn('[ingestChatCampaignTask] Failed to check recent client for channel:', err);
        }
      }
    }

    const isKaae = clientId === KAAE_CLIENT_ID;
    // A client still being set up is saved for the art director, not drafted automatically (ADR-127).
    const autoGenerate = Boolean(autoGenerateRequested) && autoDraftAllowedFor(clientId);
    let taskId = crypto.randomUUID();

    // No model was called during intake: do not manufacture cost or generation receipts.
    const preFlight = { allowed: true };
    const costReceipt: CostReceipt | null = null;
    let taskStatus = 'RECEIVED';

    // 3. Construct Brief with Strict Language Canon & Directive Separation
    let clientInstructions = '';
    let payloadText = rawText.trim();
    // ADR-284 addendum (follow-up, 2026-10-03): a first line that is only a greeting ("Hello", Sorani "hello
    // brother", "good morning", Arabic "peace be upon you") above the brief is not its headline. It was printed as
    // the design's headline and named it, and it hid a request line under it from the openings below. It is kept
    // with the instructions (nothing the requester wrote is lost); a greeting that is the whole message stays.
    const greetingLine = /^([^\n]*)\n+/u.exec(payloadText);
    const greeting = greetingLine && isGreetingOnly(greetingLine[1]) && payloadText.slice(greetingLine[0].length).trim()
      ? greetingLine[1].trim() : '';
    if (greeting) payloadText = payloadText.slice(greetingLine![0].length).trim();

    // Set when a line introduces the copy ("Here is the text and the photos:"): each line after it
    // is then one copy block, in the order written (see isCopyIntroducer, 2026-09-29).
    let copyIsIntroduced = false;

    // 3a. Check for explicit divider lines: e.g. __________, ----------, ==========, ***
    const dividerMatch = payloadText.match(/\n\s*([_\-=\*]{3,})\s*\n/);
    const introduced = dividerMatch ? null : splitAtCopyIntroducer(payloadText);
    if (dividerMatch && dividerMatch.index !== undefined) {
      clientInstructions = payloadText.slice(0, dividerMatch.index).trim();
      payloadText = payloadText.slice(dividerMatch.index + dividerMatch[0].length).trim();
    } else if (introduced) {
      // 3a'. A line that introduces the text: everything above it and the line itself are
      // instructions (kept, so nothing the requester wrote is lost), everything below it is copy.
      clientInstructions = [introduced.instructions, introduced.introducer].filter(Boolean).join('\n');
      payloadText = introduced.copy;
      copyIsIntroduced = true;
    } else {
      // 3b. Check for explicit copy section headers (e.g. "Content:", "Copy:", "Text:", "دەق:")
      const sectionMatch = payloadText.match(/\n\s*(?:content|copy|text|invitation|details|دەق|ناوەڕۆک)\s*:\s*\n?/i);
      if (sectionMatch && sectionMatch.index !== undefined) {
        clientInstructions = payloadText.slice(0, sectionMatch.index).trim();
        payloadText = payloadText.slice(sectionMatch.index + sectionMatch[0].length).trim();
      } else {
        // 3c. If message begins with conversational opening directives, strip leading directive block.
        // The list grew on 2026-09-23: "Please make a KAAE poster with these photos" and "Design a
        // post for…" were set as the design's headline, a paid draft with the request printed on it.
        // The boundary after the opening is a Unicode letter class, not \b: \b is ASCII only, so
        // "تکایە" was never followed by a boundary and the Kurdish openings never matched. A Kurdish
        // request that opened with "تکایە ..." kept that line as copy, and the instruction became
        // the headline of the design.
        const conversationalParagraph = payloadText.match(/^(?:i need|i want|we need|we want|please (?:create|make|design|prepare|do)|can you (?:design|make|create|prepare)|could you (?:design|make|create|prepare)|design request|here is|design an?|make an?|create an?|prepare an?|kindly (?:design|make|create|prepare)|تکایە|دیزاینێک|دیزاینێکم دەوێت|پۆستەرێک|دەمانەوێت|دەمەوێت|پێویستمان بە|بۆمان دروست بکە|دروست بکە|ئامادە بکە)(?![\p{L}\p{N}\p{M}_])[\s\S]*?(?=\n\s*\n)/iu);
        // ADR-284 addendum (follow-up): below a greeting line the opening is read as it always was, except a request
        // that carries the event's name ("Good morning everyone / Could you design a poster for our Annual
        // Accreditation Conference?"): the greeting kept such a line for the copy reader, which keeps the name. Only a
        // request that carries nothing to print (or only the client's name) is set aside as instructions.
        const requestOnly = (said: string) => !greeting || copyBesideRequest(said.replace(/\s*\n\s*/g, ' '),
          clientNamesFor(clientId, clientId === KAAE_CLIENT_ID ? 'KAAE' : null)).length === 0;
        if (conversationalParagraph && payloadText.length > conversationalParagraph[0].length + 20 && requestOnly(conversationalParagraph[0])) {
          clientInstructions = conversationalParagraph[0].trim();
          payloadText = payloadText.slice(conversationalParagraph[0].length).trim();
        } else {
          const conversationalMatch = payloadText.match(/^(?:i need|i want|we need|we want|please (?:create|make|design|prepare|do)|can you (?:design|make|create|prepare)|could you (?:design|make|create|prepare)|design request|here is|design an?|make an?|create an?|prepare an?|kindly (?:design|make|create|prepare)|تکایە|دیزاینێک|دیزاینێکم دەوێت|پۆستەرێک|دەمانەوێت|دەمەوێت|پێویستمان بە|بۆمان دروست بکە|دروست بکە|ئامادە بکە)(?![\p{L}\p{N}\p{M}_])[^\n]*\n+/iu);
          if (conversationalMatch && payloadText.length > conversationalMatch[0].length + 20 && requestOnly(conversationalMatch[0])) {
            clientInstructions = conversationalMatch[0].trim();
            payloadText = payloadText.slice(conversationalMatch[0].length).trim();
          }
        }
      }
    }

    if (greeting) clientInstructions = [greeting, clientInstructions].filter(Boolean).join('\n');

    // "KAAE poster:" on a line of its own names the job; it is not the headline.
    if (!clientInstructions) {
      const header = payloadText.match(/^([^\n]{0,60}(?:poster|design|post|flyer|invitation|banner|story|پۆستەر|دیزاین|بانگهێشت)[^\n]{0,40}):\s*\n+/iu);
      if (header && payloadText.length > header[0].length + 20) {
        clientInstructions = header[1].trim();
        payloadText = payloadText.slice(header[0].length).trim();
      }
    }

    // Copy wrapped in brackets or quotes, with a remark after the close: the marks are not copy, and
    // the remark is an instruction (the same rule the design path applies).
    const envelope = unwrapCopyEnvelope(payloadText);
    if (envelope.copy !== payloadText.trim()) {
      payloadText = envelope.copy;
      if (envelope.trailing) clientInstructions = [clientInstructions, envelope.trailing].filter(Boolean).join('\n');
    }
    // "I attached the panelists pictures and a reference" at the end is addressed to us, not copy.
    const peeled = peelTrailingRemarks(payloadText);
    if (peeled.remarks) {
      payloadText = peeled.copy;
      clientInstructions = [clientInstructions, peeled.remarks].filter(Boolean).join('\n');
    }
    // "Keep it simple.", "Regards, Ahmed", "… Thanks!" closing a laid-out brief are said to the designer (hunt 3).
    const closing = peelClosingInstructions(payloadText);
    if (closing.remarks) {
      payloadText = closing.copy;
      clientInstructions = [clientInstructions, closing.remarks].filter(Boolean).join('\n');
    }

    const payloadLines = payloadText.split('\n').map((l) => l.trim()).filter(Boolean);
    const firstNonEmptyPayloadLine = payloadLines[0] || '';

    const hasKurdishOrArabic = /[\u0600-\u06FF]/.test(payloadText || rawText);
    const primaryLanguage: 'en' | 'ckb' = hasKurdishOrArabic ? 'ckb' : 'en';
    const direction: 'ltr' | 'rtl' = primaryLanguage === 'en' ? 'ltr' : 'rtl';

    const isInvitation =
      rawText.toLowerCase().includes('invitation') ||
      rawText.includes('بانگهێشت') ||
      payloadText.toLowerCase().includes('cordially requests') ||
      payloadText.toLowerCase().includes('invitation only');

    let headlineEn: string | undefined;
    let headlineCkb: string | undefined;
    let copyEn: string | undefined;
    let copyCkb: string | undefined;
    let title: string;

    const remainingPayloadText = payloadLines.slice(1).join('\n').trim();
    // With no headline the title says so, rather than ending in an empty ellipsis. A headline that
    // already starts with the client's name ("KAAE K-12 Pilot Study") is not prefixed with it again,
    // and the direction marks a Sorani keyboard puts before Latin copy are not part of the name (ADR-180).
    // ADR-231: request-title.ts, also without the format and verb before the subject ("an Instagram post
    // announcing our …") and with no direction mark at either edge.
    // Live 2026-10-02: a packed client's request was labelled with the sender's first name ("Canary: Spring
    // Concert" for the Canary Test client). The label is the client's short name, else the sender's.
    const clientName = isKaae ? 'KAAE' : clientPackOf(clientId)?.names.en;
    const titleFor = (headline: string) => requestTitle({ headline, label: clientName ?? senderName, rawText, clientLabel: Boolean(clientName) });

    if (input.isInstructionOnly) {
      headlineEn = undefined;
      headlineCkb = undefined;
      copyEn = undefined;
      copyCkb = undefined;
      // ADR-182: named by its own first line, as any brief is. "Directive (…)" reached the requester
      // ("A designer will make Directive (make me a nice poster…)").
      // ADR-200 addendum (incident 2026-10-01): the first line that names a design; with none (redo or
      // quality words, chat, a question: "do a better design thats similar to earlier ones"), a neutral
      // name. The words stay the request's instructions either way.
      const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
      const named = lines.find((line) => !isWeakBriefLine(line));
      const neutral = neutralRequestTitle(senderName);
      title = named !== undefined || !lines.length ? titleFor(named ?? '') : clientName ? `${clientName}: ${neutral}` : neutral;
      // A directive stays RECEIVED, as the database records it; isInstructionOnly marks it. It was
      // CLARIFICATION_REQUIRED here, a word no other layer had, until the database row overwrote it.
    } else if (primaryLanguage === 'en') {
      headlineEn = firstNonEmptyPayloadLine;
      copyEn = remainingPayloadText;
      title = titleFor(headlineEn);
    } else {
      // Client copy is never invented: what the message did not carry stays empty, as in English.
      const normalizedRemaining = remainingPayloadText ? normalizeKurdishIncomingText(remainingPayloadText) : '';
      headlineCkb = firstNonEmptyPayloadLine.slice(0, 65);
      copyCkb = normalizedRemaining && normalizedRemaining !== headlineCkb ? normalizedRemaining : '';
      title = titleFor(headlineCkb);
    }

    // Preserve every submitted paragraph, including unfamiliar event details. A template
    // parser must never discard copy or invent missing event facts during intake.
    // Copy under a line that introduces it ("Here is the text and the photos:") is read line by line:
    // the requester listed title, subtitle and supporting text one per line, and asked for them
    // exactly as written, so each line is its own block, in order, in its own script. Elsewhere a
    // paragraph stays one block, as before (a two-line date and venue is one detail).
    const scriptOf = (text: string) => /[؀-ۿ]/.test(text)
      ? { language: 'ckb' as const, direction: 'rtl' as const }
      : { language: 'en' as const, direction: 'ltr' as const };
    const exactCopy: ExactCopyBlock[] = input.isInstructionOnly
      ? []
      : copyIsIntroduced
        ? payloadLines.map((text, index) => ({
            id: `copy_${index}`, role: index === 0 ? 'headline' : 'body', text,
            ...scriptOf(text), approved: true, protectedTokens: [],
          }))
        : payloadText.split(/\n\s*\n/).filter(t=>t.trim()).map((text,index)=>({
            id: `copy_${index}`, role: index===0?'headline':'body', text: text.trim(),
            language: primaryLanguage, direction, approved: true, protectedTokens: [],
          }));

    // A pack client other than KAAE gets its own default canvas (a thumbnail client: 1280x720).
    const packCanvas = (() => { const pack = isKaae ? undefined : clientPackOf(clientId); return pack ? defaultCanvasFor(pack) : undefined; })();
    const override = input.variantOverride;
    if (override && (!Number.isInteger(override.width) || !Number.isInteger(override.height) ||
        override.width < 1 || override.height < 1 || override.width > 16384 || override.height > 16384))
      throw new Error('Invalid source-derived canvas');
    const variantWidth = override?.width ?? packCanvas?.width ?? 1080;
    const variantHeight = override?.height ?? packCanvas?.height ?? (isInvitation || isKaae ? 1350 : 1080);
    const variantAspect = override ? `${variantWidth}:${variantHeight}` : packCanvas?.aspect ?? (isInvitation || isKaae ? '4:5' : '1:1');
    const variantRole: 'instagram_post' | 'instagram_story' | 'billboard' | 'banner' | 'custom' =
      override?.width === 1080 && override.height === 1920 ? 'instagram_story' : isInvitation || override ? 'custom' : 'instagram_post';

    const brief: DesignBrief = {
      briefId: crypto.randomUUID(),
      taskId,
      clientId: clientId || defaultClientId,
      clientDnaVersion: 1,
      objective: title,
      taskRoute: 'creative_director',
      primaryLanguage,
      direction,
      variants: [
        { id: 'v1', name: isInvitation ? 'VIP Invitation Card' : 'Announcement Post', width: variantWidth, height: variantHeight, aspectRatio: variantAspect, role: variantRole },
      ],
      exactCopy,
      missingFacts: [],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    const ctx: RequestContext = {
      tenantId: 'tenant-default',
      taskId,
      actor: { type: 'adapter', id: platform },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 180000).toISOString(),
      idempotencyKey: `idem_${platform}_${sourceEventId}`,
    };

    let revisionId: string | undefined;
    let latestQAReport: any = undefined;
    let finalDoc: any = null;
    let generatedOps: StudioOperation[] = [];
    let designRefusal: 'COPY_REQUIRED' | undefined;

    // The draft itself is the durable worker's job, so an automatic request stays in RECEIVED.
    if (autoGenerate && preFlight.allowed) taskStatus = 'RECEIVED';

    /**
     * The legacy inline preview for this task, drawn only after the request is saved.
     *
     * On 2026-09-20 a long KAAE invitation was answered 503 and never saved: this ran before
     * persistence, and the invitation template throws on copy that does not fit its fixed canvas
     * ("Invitation copy exceeds safe canvas bounds"). Telegram retried the same update into the
     * same throw, so the request was lost with no row anywhere. The preview is a convenience;
     * nothing it does may decide the HTTP status or cost the office a request.
     */
    const drawLegacyPreviewOperations = async () => {
      if (!autoGenerate || !preFlight.allowed) return;
      const isKaaeClient = clientId === KAAE_CLIENT_ID || clientId === 'client-office-1' || clientId === 'client-kaae' || String(clientId).includes('kaae');
      const isBrandClient = clientId === 'client-fastpay' || clientId === 'client-aster' || clientId === 'client-drustee';
      // KAAE is still refused a request without copy, but gets no inline preview: its v1 templates are
      // retired (ADR-127) and its designs are made only in the design studio.
      const template = isKaaeClient ? 'kaae' : isBrandClient ? 'brand' : null;
      try {
        if (template && inlineTemplateCopyMissing(template, { headlineEn, headlineCkb, copyEn, copyCkb })) {
          designRefusal = 'COPY_REQUIRED';
        } else if (isBrandClient) {
          const dna=await resolveClientDna(task.clientId,{tenantId:db?task.tenantId:DEFAULT_TENANT_ID,
            userId:SYSTEM_AUTOMATION_USER_ID,role:'operator',requireDatabase:true});
          if(db && !dna) throw new Error('Active client DNA is unavailable; preview skipped');
          generatedOps = creativeDirector.generateCommercialBrandOperations(clientId!.replace('client-', ''), brief, {
            headlineEn,
            headlineCkb,
            copyEn,
            copyCkb,
            learnedRules: dna?.guidelines?.layoutRules ?? [],
          });
        }
      } catch (err) {
        generatedOps = [];
        log.warn(
          `[ingestChatCampaignTask] Task ${taskId} is saved; its inline preview was not drawn ` +
            `(${err instanceof Error ? err.message : String(err)}). The design is produced in the studio.`
        );
      }
    };

    const task: any = {
      id: taskId,
      tenantId: 'tenant-default',
      clientId,
      projectId: null,
      status: taskStatus,
      priority: autoGenerate ? 'high' : 'routine',
      sourcePlatform: platform,
      sourceEventId,
      sourceChannelId,
      idempotencyKey: `idem_${platform}_${sourceEventId}`,
      senderName,
      kurdishText: rawText,
      title,
      headlineCkb,
      headlineEn,
      copyCkb,
      copyEn,
      payloadText,
      brief,
      finalDoc,
      generatedOps,
      costReceipt,
      latestRevisionId: revisionId,
      latestQAReport,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // The lifecycle path uses this exact draft without a Core task or Telegram effect. Keeping
    // one construction path prevents a new request from changing client or factual copy at cutover.
    const CLIENT_ALIAS_TO_UUID: Record<string, string> = {
      'client-kaae': KAAE_CLIENT_ID, 'kaae': KAAE_CLIENT_ID,
      'client-drustee': 'c1000000-0000-4000-8000-000000000003', 'drustee': 'c1000000-0000-4000-8000-000000000003',
      'client-fastpay': 'c1000000-0000-4000-8000-000000000004', 'fastpay': 'c1000000-0000-4000-8000-000000000004',
      'client-hawa': 'c1000000-0000-4000-8000-000000000001', 'hawa': 'c1000000-0000-4000-8000-000000000001',
    };
    const durableClient = clientId && isValidUuid(clientId)
      ? clientId
      : (clientId && CLIENT_ALIAS_TO_UUID[clientId]) || null;
    const preparedDraft: ChatIntake = {
      platform, sourceEventId, sourceChannelId, rawText, rawJson: input.rawJson,
      clientId: durableClient, title, headlineEn, headlineCkb, copyEn, copyCkb,
      designInstructions: clientInstructions, exactCopy,
      isInstructionOnly: Boolean(input.isInstructionOnly),
      autoGenerate: Boolean(autoGenerate && durableClient && !input.isInstructionOnly),
      variant: { width: variantWidth, height: variantHeight },
      studioOptions: referenceImageBase64 || input.rawJson?.message?.media_group_id
        ? {
            ...(referenceImageBase64 ? { referenceImageBase64 } : {}),
            ...(input.rawJson?.message?.media_group_id ? { mediaGroupId: String(input.rawJson.message.media_group_id) } : {}),
          }
        : undefined,
    };
    if (prepareOnly) return { kind: 'prepared' as const, draft: preparedDraft };

    const existingMemoryTask = db ? undefined : Array.from(tasks.values()).find(
      (t: any) => t.sourcePlatform === platform && t.sourceEventId === sourceEventId
    );
    if (existingMemoryTask) {
      return {
        task: existingMemoryTask,
        brief: briefs.get(existingMemoryTask.id) || brief,
        costReceipt,
        latestQAReport: existingMemoryTask.latestQAReport,
        duplicate: true,
      };
    }

    let persistedVersion: number | null = null;
    if (db) {
      const persisted = await persistChatIntake(db, preparedDraft);
      taskId = persisted.task.id;
      task.autoGenerateDeclined = persisted.autoGenerateDeclined;
      task.id = taskId; task.tenantId = persisted.tenantId; task.clientId = persisted.task.client_id;
      task.status = toApiTaskStatus(persisted.task.state); task.state = persisted.task.state;
      task.createdAt = persisted.task.created_at; task.updatedAt = persisted.task.updated_at;
      persistedVersion = Number(persisted.task.version) || null;
      brief.taskId = taskId;
      if (!persisted.created) {
        await drawLegacyPreviewOperations();
        task.generatedOps = generatedOps;
        if (designRefusal) task.designRefusal = designRefusal;
        return { task, brief, costReceipt, latestQAReport, duplicate: true };
      }
    } else if (isProduction) {
      throw new Error('Durable chat intake requires PostgreSQL; no task was acknowledged');
    }

    // The request is committed. Everything after this point is presentation.
    await drawLegacyPreviewOperations();
    task.generatedOps = generatedOps;
    if (designRefusal) task.designRefusal = designRefusal;

    // Without a database this process is where the task lives (services/no-database-store.ts); with
    // one it is in Postgres already, and a copy here would answer for it after it changed.
    if (!db) {
      briefs.set(taskId, brief);
      tasks.set(taskId, task);
      events.set(taskId, [
        {
          eventId: crypto.randomUUID(),
          taskId,
          fromStatus: null,
          toStatus: task.status,
          actor: ctx.actor,
          reason: `Incoming ${platform} message processed`,
          occurredAt: new Date().toISOString(),
        },
      ]);
    }

    broadcast('webhook:received', { platform, updateId: sourceEventId, taskId });
    broadcast('task:created', task);
    if (autoGenerate) {
      broadcastTransition(taskId, null, task.status, persistedVersion);
      if (latestQAReport) {
        broadcast('task:qa_completed', { taskId, revisionId, qaReport: latestQAReport });
      }
    }

    let notification: {success:boolean;messageId?:string;error?:string} | undefined;
    // 5. Outbound Telegram Dispatch
    if (platform === 'telegram' && (!sourceChannelId || sourceChannelId === 'tg_default')) {
      // The task is created either way, so without this the request simply lands in the queue and
      // the person who sent it is never acknowledged — indistinguishable, from their side, from
      // the system ignoring them.
      log.error(
        `[telegram] Task accepted but the sender cannot be acknowledged: no usable source channel ` +
          `(got ${JSON.stringify(sourceChannelId)}). Sender=${JSON.stringify(senderName)} ` +
          `event=${JSON.stringify(sourceEventId)}.`
      );
    }
    if (platform === 'telegram' && sourceChannelId && sourceChannelId !== 'tg_default') {
      // A pack names its client (ADR-127); the legacy demo clients keep their names until retired.
      const clientPack = clientPackOf(clientId);
      let clientDisplayName = isKaae ? 'KAAE (Accreditation)' : senderName;
      if (clientId === 'client-fastpay' || clientId === 'c1000000-0000-4000-8000-000000000004') clientDisplayName = 'FastPay Mobile Wallet';
      else if (clientId === 'client-aster') clientDisplayName = 'Aster Pharmacy';
      else if (clientId === 'client-drustee' || clientId === 'c1000000-0000-4000-8000-000000000003') clientDisplayName = 'Drustee Health';
      else if (clientId === 'c1000000-0000-4000-8000-000000000001') clientDisplayName = 'Hawa Studio';
      if (clientPack) clientDisplayName = clientPack.displayName;

      // The Canva draft itself is produced by the durable worker workflow (Restate), never inline
      // in the webhook: the model call and the Canva import can take minutes, must survive a Core
      // restart, and must never run twice. The worker reports the outcome back through
      // POST /v1/tasks/:taskId/notifications/canva-status, which sends the link or the reason.
      const deskLink = officeReviewUrl({ taskId }, deskBaseUrl);
      // An unscoped brief named the sender here, as if they were the client.
      const clientLabel = escapeTelegramHtml(isKaae ? clientDisplayName : task.clientId ? clientDisplayName : 'not named in the message');
      // A client still being set up (ADR-127) has no Client DNA to design with, so nothing is drafted for it.
      const onboardingNote = task.clientId && clientPack?.status === 'onboarding'
        ? `\n\n🛠 <i>${escapeTelegramHtml(clientPack.displayName)} is still being set up in Hawa, so no automatic draft is made yet. The art director will design this one in Canva.</i>`
        : '';
      const safeTitle = escapeTelegramHtml(title || 'Campaign Design');
      const automaticDraft = Boolean(autoGenerate && task.clientId && !task.autoGenerateDeclined);
      const capNote = task.autoGenerateDeclined
        ? `\n\n⏳ <i>The daily limit for automatic drafts has been reached${task.autoGenerateDeclined === 'SENDER_DAILY_CAP' ? ' for this chat' : ' for the office'}. Your request is saved and the art director will design it in Canva.</i>`
        : '';
      const scopeNote = (task.clientId
        ? ''
        : `\n\n⚠️ <i>No client was named, so nothing is designed automatically. Send it again with the client's name in it (for example KAAE) to get a Canva draft, or assign the client in Hawa Desk.</i>`) + onboardingNote + capNote;
      const text =
        `📥 <b>${automaticDraft ? 'Request saved. Preparing your Canva draft' : 'Brief received and queued in Hawa Desk'}</b>\n\n` +
        `📌 <b>Task ID:</b> <code>${taskId}</code>\n` +
        `🏢 <b>Client:</b> ${clientLabel}\n` +
        `📜 <b>Title:</b> ${safeTitle}\n` +
        `📐 <b>Format:</b> ${variantWidth}×${variantHeight} (${variantAspect})\n\n` +
        (automaticDraft
          ? `✏️ An editable Canva draft is being prepared automatically. You will receive the Canva link in this chat when it is ready, or an explanation if it cannot be produced automatically.\n`
          : `⚡ The art director has received your brief and will design it in Canva.\n`) +
        `<i>Every design is reviewed by the art director in Hawa Desk before release.</i>` + scopeNote;
      // A deployment without a public HTTPS Desk origin must not send a localhost link.
      const deskButton = deskLink ? { inline_keyboard: [[{ text: '🖥 Open in Hawa Desk', url: deskLink }]] } : undefined;
      notification = await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
        text,
        parse_mode: 'HTML',
        ...(deskButton ? { reply_markup: deskButton } : {}),
      });
    }

    if (notification && !notification.success) log.warn(`[TelegramBridge] Request saved but notification failed: ${notification.error}`);
    return { task, brief, costReceipt, latestQAReport, notification };
  }

  async function ingestChatCampaignTask(input: Parameters<typeof doIngestChatCampaignTask>[0]) {
    const result = await doIngestChatCampaignTask(input);
    if ('kind' in result && result.kind === 'prepared') throw new Error('Task intake did not persist');
    return result;
  }

  async function prepareChatCampaignDraft(input: Parameters<typeof doIngestChatCampaignTask>[0]): Promise<ChatIntake> {
    const result = await doIngestChatCampaignTask(input, true);
    if ('kind' in result && result.kind === 'prepared') return result.draft;
    throw new Error('New-brief planning unexpectedly persisted a task');
  }

  return { ingestChatCampaignTask, prepareChatCampaignDraft };
}
