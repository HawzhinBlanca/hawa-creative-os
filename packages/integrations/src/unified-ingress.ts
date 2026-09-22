import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  MessageEnvelope,
  NormalizedAttachment,
  AdapterKind,
  UUID,
  SHA256,
} from '@hawa/contracts';

// Maximum allowed attachment size (50MB bound per FR-006)
export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;

export const ALLOWED_INGRESS_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
  'image/gif',
  'application/pdf',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
]);

export const DISALLOWED_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin',
  'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'php', 'py', 'rb', 'pl', 'cgi', 'vbs', 'com', 'scr',
]);

/**
 * SSRF defense validator for external media fetch destinations.
 * Rejects private, loopback, link-local, multicast and reserved IP addresses.
 */
export function validateFetchDestination(targetUrl: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, reason: `Disallowed protocol: ${url.protocol}` };
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.corp')
    ) {
      return { valid: false, reason: `Private/internal hostname rejected: ${hostname}` };
    }

    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);
    if (match) {
      const [_, o1, o2, o3, o4] = match.map(Number);
      if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) {
        return { valid: false, reason: `Malformed IPv4 address: ${hostname}` };
      }
      if (o1 === 0) return { valid: false, reason: 'Disallowed IP: 0.0.0.0/8' };
      if (o1 === 10) return { valid: false, reason: 'Disallowed private IP: 10.0.0.0/8' };
      if (o1 === 127) return { valid: false, reason: 'Disallowed loopback IP: 127.0.0.0/8' };
      if (o1 === 169 && o2 === 254) return { valid: false, reason: 'Disallowed link-local / metadata IP: 169.254.0.0/16' };
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return { valid: false, reason: 'Disallowed private IP: 172.16.0.0/12' };
      if (o1 === 192 && o2 === 168) return { valid: false, reason: 'Disallowed private IP: 192.168.0.0/16' };
      if (o1 >= 224 && o1 <= 239) return { valid: false, reason: 'Disallowed multicast IP' };
      if (o1 >= 240) return { valid: false, reason: 'Disallowed reserved IP' };
    }

    if (hostname.includes(':') || hostname.startsWith('[') || hostname === '::1') {
      const cleanIpv6 = hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (
        cleanIpv6 === '::1' ||
        cleanIpv6 === '::' ||
        cleanIpv6.startsWith('fc') ||
        cleanIpv6.startsWith('fd') ||
        cleanIpv6.startsWith('fe80')
      ) {
        return { valid: false, reason: `Disallowed private/loopback IPv6: ${cleanIpv6}` };
      }
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Invalid URL: ${err.message}` };
  }
}

/**
 * Sanitizes incoming text and normalizes Kurdish Sorani orthography.
 */
export function sanitizeIngressContent(text: string): { sanitized: string; violations: string[] } {
  const violations: string[] = [];
  if (!text) {
    return { sanitized: '', violations };
  }

  let cleaned = text;

  // 1. Remove null bytes and ASCII control characters (keep \t, \n, \r)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(cleaned)) {
    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    violations.push('Stripped ASCII control characters or null bytes');
  }

  // 2. Strip HTML/Script tags and unclosed/self-closing elements
  const scriptRegex = /<script\b[^>]*\/?>[\s\S]*?(?:<\/script>|$)|<script\b[^>]*\/?>/gi;
  if (scriptRegex.test(cleaned)) {
    cleaned = cleaned.replace(scriptRegex, '');
    violations.push('Stripped executable script tags');
  }

  const dangerousTagsRegex = /<(iframe|object|embed|form|applet|meta|link|base)\b[^>]*\/?>[\s\S]*?(?:<\/\1>|$)|<(iframe|object|embed|form|applet|meta|link|base)\b[^>]*\/?>/gi;
  if (dangerousTagsRegex.test(cleaned)) {
    cleaned = cleaned.replace(dangerousTagsRegex, '');
    violations.push('Stripped dangerous embedded HTML tags');
  }

  // 3. Strip event handlers and javascript: URI schemes
  const eventHandlerRegex = /(?:[\s/])+(on[a-zA-Z0-9_-]+)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi;
  if (eventHandlerRegex.test(cleaned)) {
    cleaned = cleaned.replace(eventHandlerRegex, '');
    violations.push('Stripped dangerous inline event handlers');
  }

  const jsProtocolRegex = /(?:href|src|data|action)\s*=\s*(?:'javascript:[^']*'|"javascript:[^"]*"|javascript:[^\s>]+)/gi;
  if (jsProtocolRegex.test(cleaned)) {
    cleaned = cleaned.replace(jsProtocolRegex, '');
    violations.push('Stripped javascript: pseudo-protocol URIs');
  }

  // 4. Normalize Kurdish Sorani orthography
  // Convert Arabic Yeh (\u064A) -> Kurdish/Farsi Yeh (ی)
  // Convert Arabic Kaf (\u0643) -> Keheh (ک)
  // Preserve Zero-Width Non-Joiner (ZWNJ, \u200C)
  cleaned = cleaned
    .replace(/\u064A/g, 'ی')
    .replace(/\u0643/g, 'ک')
    .replace(/\r\n/g, '\n');

  // 5. Bound max text length (10,000 characters)
  const MAX_TEXT_LENGTH = 10_000;
  if (cleaned.length > MAX_TEXT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_TEXT_LENGTH);
    violations.push(`Text truncated to ${MAX_TEXT_LENGTH} characters`);
  }

  return { sanitized: cleaned.trim(), violations };
}

/**
 * Attachment input specification.
 */
export interface IngressAttachmentInput {
  sourceAttachmentId?: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
  content?: Buffer | Uint8Array;
  storageKey?: string;
  mediaUrl?: string;
}

/**
 * Validates attachment constraints (size bounds, MIME whitelist, hash integrity).
 */
export function validateIngressAttachment(attachment: IngressAttachmentInput): {
  valid: boolean;
  reason?: string;
  sha256: SHA256;
  storageKey: string;
  scanState: 'clean' | 'rejected' | 'quarantined';
} {
  if (attachment.byteSize > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      valid: false,
      reason: `Attachment size ${attachment.byteSize} bytes exceeds 50MB limit`,
      sha256: (attachment.sha256 || '0'.repeat(64)) as SHA256,
      storageKey: attachment.storageKey || `rejected_${Date.now()}`,
      scanState: 'rejected',
    };
  }

  const ext = attachment.filename.split('.').pop()?.toLowerCase() || '';
  if (DISALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `Disallowed dangerous file extension: .${ext}`,
      sha256: (attachment.sha256 || '0'.repeat(64)) as SHA256,
      storageKey: attachment.storageKey || `rejected_${Date.now()}`,
      scanState: 'rejected',
    };
  }

  const mime = attachment.mimeType.toLowerCase();
  if (!ALLOWED_INGRESS_MIME_TYPES.has(mime) && !mime.startsWith('image/') && !mime.startsWith('audio/')) {
    return {
      valid: false,
      reason: `Disallowed MIME type: ${attachment.mimeType}`,
      sha256: (attachment.sha256 || '0'.repeat(64)) as SHA256,
      storageKey: attachment.storageKey || `rejected_${Date.now()}`,
      scanState: 'rejected',
    };
  }

  if (attachment.mediaUrl) {
    const ssrfCheck = validateFetchDestination(attachment.mediaUrl);
    if (!ssrfCheck.valid) {
      return {
        valid: false,
        reason: `Attachment fetch destination blocked: ${ssrfCheck.reason}`,
        sha256: (attachment.sha256 || '0'.repeat(64)) as SHA256,
        storageKey: attachment.storageKey || `rejected_${Date.now()}`,
        scanState: 'quarantined',
      };
    }
  }

  // Verify hash integrity against content if content is provided
  let hash = attachment.sha256;
  if (attachment.content) {
    const computedHash = createHash('sha256').update(attachment.content).digest('hex');
    if (hash && hash.toLowerCase() !== computedHash.toLowerCase()) {
      return {
        valid: false,
        reason: `Attachment SHA-256 hash mismatch: claimed ${hash} but computed ${computedHash}`,
        sha256: (attachment.sha256 || '0'.repeat(64)) as SHA256,
        storageKey: attachment.storageKey || `rejected_${Date.now()}`,
        scanState: 'rejected',
      };
    }
    hash = computedHash;
  }

  if (!hash || hash.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    return {
      valid: false,
      reason: 'Missing or invalid SHA-256 hash',
      sha256: '0'.repeat(64) as SHA256,
      storageKey: attachment.storageKey || `rejected_${Date.now()}`,
      scanState: 'rejected',
    };
  }

  // Sanitize filename to prevent path traversal
  const rawBase = path.basename(attachment.filename.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeFilename = (!rawBase || rawBase === '.' || rawBase === '..')
    ? `attachment_${Date.now()}.${ext || 'bin'}`
    : rawBase;

  const storageKey = attachment.storageKey || `attachments/${hash}/${safeFilename}`;
  return { valid: true, sha256: hash as SHA256, storageKey, scanState: 'clean' };
}

export type IngressAction =
  | 'message_only'
  | 'task_created'
  | 'revision_requested'
  | 'clarification_needed'
  | 'duplicate_acknowledged';

export interface IngressIntentEvaluation {
  action: 'message_only' | 'promote' | 'revision' | 'clarification';
  clarificationPrompt?: string;
  detectedClientId?: string;
  commandName?: string;
  explicitTitle?: string;
}

import { KAAE_CLIENT_ID } from './waha-ingress.js';
export { KAAE_CLIENT_ID };
import { CHANNEL_INGRESS_USER_ID } from '@hawa/contracts';

/**
 * Intent evaluation engine enforcing the conversational gate:
 * MESSAGE_ONLY by default. Ordinary group conversation creates no tasks.
 * Ambiguity produces clarification prompts instead of speculative task generation.
 */
export function evaluateIngressIntent(params: {
  text: string;
  channel: AdapterKind;
  isTaskSubmission?: boolean;
  replyContext?: string;
  explicitClientId?: string | null;
  hasTargetTask?: boolean;
}): IngressIntentEvaluation {
  const { text, channel, isTaskSubmission, replyContext, explicitClientId, hasTargetTask } = params;
  const trimmed = text.trim();

  // 1. Desk task form submission is an explicit promotion
  if (channel === 'hawa_desk' && isTaskSubmission) {
    return {
      action: 'promote',
      detectedClientId: explicitClientId || undefined,
      explicitTitle: trimmed.split('\n')[0]?.slice(0, 100),
    };
  }

  // 2. Slash commands for explicit task/brief promotion
  if (trimmed.startsWith('/')) {
    const [cmd, ...args] = trimmed.split(' ');
    const cmdLower = cmd.toLowerCase();
    if (['/task', '/brief', '/design', '/campaign', '/new'].includes(cmdLower)) {
      const rest = args.join(' ').trim();
      return {
        action: 'promote',
        commandName: cmdLower,
        explicitTitle: rest.slice(0, 100) || 'Untitled Campaign Request',
      };
    }
    if (['/revise', '/change', '/fix'].includes(cmdLower)) {
      return {
        action: 'revision',
        commandName: cmdLower,
      };
    }
  }

  // 3. Explicit Kurdish / English task prefixes
  const explicitPrefixMatch = trimmed.match(/^(task|brief|design|campaign|داواکاری|دیزاین|کەمپین)\s*:\s*(.+)/i);
  if (explicitPrefixMatch) {
    return {
      action: 'promote',
      explicitTitle: explicitPrefixMatch[2].slice(0, 100),
    };
  }

  // 4. Interactive revisions / feedback on existing task
  const isRevisionVerb =
    /^(please\s+)?(change|fix|update|remove|add|replace|make|revise|adjust|correct)\b/i.test(trimmed) ||
    /^(دەستکاری|گۆڕانکاری|چاککردنەوە|سڕینەوە|زیادکردن)\b/.test(trimmed);

  if ((replyContext || hasTargetTask) && isRevisionVerb) {
    return { action: 'revision' };
  }

  // 5. Detect Client from text keywords if not explicitly supplied
  let detectedClientId = explicitClientId || undefined;
  if (!detectedClientId) {
    const lower = trimmed.toLowerCase();
    if (
      lower.includes('kaae') ||
      trimmed.includes('باوەڕپێدان') ||
      trimmed.includes('کەی ئەی') ||
      lower.includes('accreditation')
    ) {
      detectedClientId = KAAE_CLIENT_ID;
    } else if (lower.includes('drustee') || trimmed.includes('دروستی') || trimmed.includes('ڤیتامین')) {
      detectedClientId = 'client-drustee';
    } else if (lower.includes('aster') || trimmed.includes('ئاستێر') || trimmed.includes('ئاستەر')) {
      detectedClientId = 'client-aster';
    } else if (lower.includes('fastpay') || trimmed.includes('فاستپەی')) {
      detectedClientId = 'client-fastpay';
    }
  }

  // 6. Ambiguity vs Ordinary Conversation:
  // If the user mentions design assets/collateral but lacks details:
  const designKeywords = /(poster|banner|flyer|logo|social\s+media|roll\s*up|brochure|پۆستەر|لۆگۆ|بانەر|فلایەر|بڕۆشۆر)/i;
  if (designKeywords.test(trimmed)) {
    // If it's a short question or underspecified message without concrete headline/body:
    if (trimmed.length < 50 || !detectedClientId) {
      return {
        action: 'clarification',
        clarificationPrompt:
          'To generate a verified design task, please specify the client, headline copy, and exact dimensions, or prefix your message with /task <title>.',
        detectedClientId,
      };
    }
  }

  // 7. Ordinary conversation / group chat banter defaults strictly to MESSAGE_ONLY
  return { action: 'message_only', detectedClientId };
}

/**
 * Persistence port required by UnifiedIngressService.
 */
export interface IngressPersistencePort {
  recordInboxEvent(params: {
    tenantId: string;
    integrationId?: string | null;
    sourceAccountId: string;
    sourceEventId: string;
    sourceSequence?: string | null;
    eventKind: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    verified: boolean;
    occurredAt?: Date | null;
  }): Promise<{ event: { id: string }; isDuplicate: boolean }>;

  recordMessageEvent(params: {
    tenantId: string;
    inboxEventId?: string | null;
    integrationId?: string | null;
    externalAccountId: string;
    externalChannelId: string;
    externalThreadId?: string | null;
    externalMessageId: string;
    externalRevisionId?: string;
    senderExternalId?: string | null;
    mappedUserId?: string | null;
    language?: string | null;
    direction?: 'ltr' | 'rtl' | 'auto' | null;
    textOriginal?: string;
    entities?: unknown[];
    occurredAt?: Date | null;
  }): Promise<{ message: { id: string }; isDuplicate: boolean }>;

  recordAttachment(params: {
    tenantId: string;
    messageEventId: string;
    sourceAttachmentId?: string | null;
    filename: string;
    mimeType: string;
    byteSize: number | bigint;
    sha256: string;
    storageKey: string;
    scanState?: 'pending' | 'clean' | 'quarantined' | 'rejected';
    metadata?: Record<string, unknown>;
  }): Promise<{ attachment: { id: string }; isDuplicate: boolean }>;

  findTaskByMessageExternal(params: {
    tenantId: string;
    integrationId?: string | null;
    externalAccountId: string;
    externalChannelId: string;
    externalMessageId: string;
  }): Promise<{ id: string; state: string; current_brief_id: string | null } | null>;

  createTaskAggregate(params: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    title: string;
    description: string;
    clientId?: string | null;
    priority?: number;
    sourceMessageId: string;
    payload?: Record<string, unknown>;
    enqueueOutbox?: boolean;
  }): Promise<{ task: { id: string; state: string }; created: boolean }>;

  recordRevisionRequest(params: {
    tenantId: string;
    taskId: string;
    sourceMessageId: string;
    newRevisionId: string;
    reason: string;
    actorExternalId?: string;
  }): Promise<void>;

  updateTaskDraft(params: {
    tenantId: string;
    taskId: string;
    sourceMessageId: string;
    newRevisionId: string;
    description: string;
  }): Promise<void>;
}

export interface UnifiedIngressInput {
  tenantId: string;
  channel: AdapterKind;
  integrationId?: UUID;
  sourceAccountId: string;
  sourceEventId: string;
  sourceChannelId: string;
  sourceThreadId?: string;
  sourceMessageId: string;
  sourceRevisionId?: string;
  senderExternalId: string;
  senderDisplayName?: string;
  text: string;
  rawPayload: unknown;
  rawPayloadHash?: string;
  verified: boolean;
  verificationMethod?: string;
  occurredAt?: string;
  receivedAt?: string;
  attachments?: IngressAttachmentInput[];
  explicitClientId?: string | null;
  isTaskSubmission?: boolean;
  replyContext?: string;
}

export interface UnifiedIngressResult {
  acknowledged: boolean;
  inboxEventId: string;
  messageEventId: string;
  revisionId: string;
  isDuplicate: boolean;
  actionTaken: IngressAction;
  taskId?: string;
  clarificationPrompt?: string;
  normalizedEnvelope: MessageEnvelope;
  violations: string[];
}

/**
 * Unified Ingress Service:
 * Routes Desk, Telegram, and WhatsApp into verified MessageEnvelope,
 * commits durably before acknowledgment, enforces the conversational gate,
 * bounds attachments, and protects approved briefs from source mutation.
 */
export class UnifiedIngressService {
  constructor(private readonly persistence: IngressPersistencePort) {}

  async ingest(input: UnifiedIngressInput): Promise<UnifiedIngressResult> {
    const receivedAt = input.receivedAt || new Date().toISOString();
    const revisionId = input.sourceRevisionId || '';
    const rawText = input.text || '';

    // 1. Sanitize text & normalize Kurdish Sorani orthography
    const sanitization = sanitizeIngressContent(rawText);
    const sanitizedText = sanitization.sanitized;
    const violations = [...sanitization.violations];

    // 2. Validate and hash attachments
    const validatedAttachments: NormalizedAttachment[] = [];
    if (input.attachments && input.attachments.length > 0) {
      for (const att of input.attachments) {
        const val = validateIngressAttachment(att);
        if (!val.valid) {
          violations.push(`Attachment rejected (${att.filename}): ${val.reason}`);
        }
        validatedAttachments.push({
          sourceId: att.sourceAttachmentId,
          filename: att.filename,
          mimeType: att.mimeType,
          byteSize: att.byteSize,
          sha256: val.sha256,
          storageKey: val.storageKey,
          scanState: val.scanState,
        });
      }
    }

    // 3. Compute raw payload hash
    const rawPayloadHash =
      (input.rawPayloadHash as SHA256) ||
      (createHash('sha256')
        .update(typeof input.rawPayload === 'string' ? input.rawPayload : JSON.stringify(input.rawPayload))
        .digest('hex') as SHA256);

    const hasKurdishOrArabic = /[\u0600-\u06FF]/.test(sanitizedText);
    const direction = hasKurdishOrArabic ? 'rtl' : 'ltr';
    const language = hasKurdishOrArabic ? 'ckb' : 'en';

    // 4. Construct verified canonical MessageEnvelope
    const normalizedEnvelope: MessageEnvelope = {
      schemaVersion: 1,
      adapter: {
        kind: input.channel,
        integrationId: input.integrationId || ('00000000-0000-4000-a000-000000000001' as UUID),
        version: '1.0.0',
      },
      source: {
        accountId: input.sourceAccountId,
        channelId: input.sourceChannelId,
        threadId: input.sourceThreadId,
        messageId: input.sourceMessageId,
        revisionId: revisionId || undefined,
        eventId: input.sourceEventId,
      },
      sender: {
        externalId: input.senderExternalId,
        displayName: input.senderDisplayName,
      },
      occurredAt: input.occurredAt,
      receivedAt,
      language,
      direction,
      text: sanitizedText,
      entities: [],
      attachments: validatedAttachments,
      reactions: [],
      verification: {
        verified: input.verified,
        method: input.verificationMethod || 'system_channel_verification',
      },
      rawPayloadHash,
    };

    // 5. Durable commit to PostgreSQL BEFORE acknowledgment (Invariant #1 & #12)
    const inboxResult = await this.persistence.recordInboxEvent({
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      sourceAccountId: input.sourceAccountId,
      sourceEventId: input.sourceEventId,
      eventKind: `${input.channel}_message`,
      payload: typeof input.rawPayload === 'object' && input.rawPayload !== null ? (input.rawPayload as any) : { raw: input.rawPayload },
      payloadHash: rawPayloadHash,
      verified: input.verified,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
    });

    const messageResult = await this.persistence.recordMessageEvent({
      tenantId: input.tenantId,
      inboxEventId: inboxResult.event.id,
      integrationId: input.integrationId,
      externalAccountId: input.sourceAccountId,
      externalChannelId: input.sourceChannelId,
      externalThreadId: input.sourceThreadId,
      externalMessageId: input.sourceMessageId,
      externalRevisionId: revisionId,
      senderExternalId: input.senderExternalId,
      language,
      direction,
      textOriginal: sanitizedText,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
    });

    // Record attachments with SHA-256 deduplication
    for (const att of validatedAttachments) {
      await this.persistence.recordAttachment({
        tenantId: input.tenantId,
        messageEventId: messageResult.message.id,
        sourceAttachmentId: att.sourceId,
        filename: att.filename,
        mimeType: att.mimeType,
        byteSize: att.byteSize,
        sha256: att.sha256,
        storageKey: att.storageKey,
        scanState: att.scanState,
      });
    }

    // 6. Handle duplicate event replays
    if (inboxResult.isDuplicate && messageResult.isDuplicate) {
      // Find any linked task to report its ID
      const existingTask = await this.persistence.findTaskByMessageExternal({
        tenantId: input.tenantId,
        integrationId: input.integrationId,
        externalAccountId: input.sourceAccountId,
        externalChannelId: input.sourceChannelId,
        externalMessageId: input.sourceMessageId,
      });

      return {
        acknowledged: true,
        inboxEventId: inboxResult.event.id,
        messageEventId: messageResult.message.id,
        revisionId,
        isDuplicate: true,
        actionTaken: 'duplicate_acknowledged',
        taskId: existingTask?.id,
        normalizedEnvelope,
        violations,
      };
    }

    // 7. Check if an existing task was linked to a prior revision of this message
    const existingTask = await this.persistence.findTaskByMessageExternal({
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      externalAccountId: input.sourceAccountId,
      externalChannelId: input.sourceChannelId,
      externalMessageId: input.sourceMessageId,
    });

    // 8. Invariant: Source edit cannot silently alter an approved brief!
    if (existingTask && revisionId && revisionId !== '') {
      const isApprovedOrPast = [
        'approved',
        'publishing',
        'complete',
        'studio_composition',
        'qa',
        'human_review',
      ].includes(existingTask.state);

      if (isApprovedOrPast) {
        // Must NOT alter approved brief; record a revision request instead
        await this.persistence.recordRevisionRequest({
          tenantId: input.tenantId,
          taskId: existingTask.id,
          sourceMessageId: messageResult.message.id,
          newRevisionId: revisionId,
          reason: `Source message edited at source after brief approval: "${sanitizedText.slice(0, 150)}"`,
          actorExternalId: input.senderExternalId,
        });

        return {
          acknowledged: true,
          inboxEventId: inboxResult.event.id,
          messageEventId: messageResult.message.id,
          revisionId,
          isDuplicate: false,
          actionTaken: 'revision_requested',
          taskId: existingTask.id,
          normalizedEnvelope,
          violations,
        };
      } else {
        // Unapproved draft: safe to update draft with revision lineage
        await this.persistence.updateTaskDraft({
          tenantId: input.tenantId,
          taskId: existingTask.id,
          sourceMessageId: messageResult.message.id,
          newRevisionId: revisionId,
          description: sanitizedText,
        });

        return {
          acknowledged: true,
          inboxEventId: inboxResult.event.id,
          messageEventId: messageResult.message.id,
          revisionId,
          isDuplicate: false,
          actionTaken: 'task_created',
          taskId: existingTask.id,
          normalizedEnvelope,
          violations,
        };
      }
    }

    // 9. Conversational Gate: evaluate intent (MESSAGE_ONLY vs Promotion)
    const intent = evaluateIngressIntent({
      text: sanitizedText,
      channel: input.channel,
      isTaskSubmission: input.isTaskSubmission,
      replyContext: input.replyContext,
      explicitClientId: input.explicitClientId,
      hasTargetTask: Boolean(existingTask),
    });

    if (intent.action === 'message_only') {
      // Ordinary group banter or conversational message. NO task created.
      return {
        acknowledged: true,
        inboxEventId: inboxResult.event.id,
        messageEventId: messageResult.message.id,
        revisionId,
        isDuplicate: false,
        actionTaken: 'message_only',
        normalizedEnvelope,
        violations,
      };
    }

    if (intent.action === 'clarification') {
      return {
        acknowledged: true,
        inboxEventId: inboxResult.event.id,
        messageEventId: messageResult.message.id,
        revisionId,
        isDuplicate: false,
        actionTaken: 'clarification_needed',
        clarificationPrompt: intent.clarificationPrompt,
        normalizedEnvelope,
        violations,
      };
    }

    if (intent.action === 'revision' && existingTask) {
      await this.persistence.recordRevisionRequest({
        tenantId: input.tenantId,
        taskId: existingTask.id,
        sourceMessageId: messageResult.message.id,
        newRevisionId: revisionId || 'rev_manual',
        reason: sanitizedText,
        actorExternalId: input.senderExternalId,
      });

      return {
        acknowledged: true,
        inboxEventId: inboxResult.event.id,
        messageEventId: messageResult.message.id,
        revisionId,
        isDuplicate: false,
        actionTaken: 'revision_requested',
        taskId: existingTask.id,
        normalizedEnvelope,
        violations,
      };
    }

    // Explicit Promotion: create task aggregate with linked source_message_id
    const taskTitle = intent.explicitTitle || sanitizedText.split('\n')[0]?.slice(0, 80) || 'Untitled Campaign';
    const idempotencyKey = `ingress_${input.channel}_${input.sourceAccountId}_${input.sourceMessageId}`;

    const taskResult = await this.persistence.createTaskAggregate({
      tenantId: input.tenantId,
      userId: CHANNEL_INGRESS_USER_ID,
      idempotencyKey,
      title: taskTitle,
      description: sanitizedText,
      clientId: intent.detectedClientId || input.explicitClientId || null,
      priority: 3,
      sourceMessageId: messageResult.message.id,
      payload: {
        channel: input.channel,
        envelope: normalizedEnvelope,
      },
      enqueueOutbox: true,
    });

    return {
      acknowledged: true,
      inboxEventId: inboxResult.event.id,
      messageEventId: messageResult.message.id,
      revisionId,
      isDuplicate: false,
      actionTaken: 'task_created',
      taskId: taskResult.task.id,
      normalizedEnvelope,
      violations,
    };
  }
}

/**
 * In-memory persistence adapter for testing and zero-db environments.
 */
export class MemoryIngressPersistenceAdapter implements IngressPersistencePort {
  readonly inboxEvents = new Map<string, any>();
  readonly messageEvents = new Map<string, any>();
  readonly attachments = new Map<string, any>();
  readonly tasks = new Map<string, any>();
  readonly revisionRequests: any[] = [];

  async recordInboxEvent(params: any): Promise<{ event: { id: string }; isDuplicate: boolean }> {
    const key = `${params.tenantId}:${params.sourceAccountId}:${params.sourceEventId}`;
    const existing = this.inboxEvents.get(key);
    if (existing) {
      return { event: existing, isDuplicate: true };
    }
    const event = { id: crypto.randomUUID(), ...params, received_at: new Date() };
    this.inboxEvents.set(key, event);
    return { event, isDuplicate: false };
  }

  async recordMessageEvent(params: any): Promise<{ message: { id: string }; isDuplicate: boolean }> {
    const rev = params.externalRevisionId || '';
    const key = `${params.tenantId}:${params.externalAccountId}:${params.externalChannelId}:${params.externalMessageId}:${rev}`;
    const existing = this.messageEvents.get(key);
    if (existing) {
      return { message: existing, isDuplicate: true };
    }
    const message = { id: crypto.randomUUID(), ...params, received_at: new Date() };
    this.messageEvents.set(key, message);
    return { message, isDuplicate: false };
  }

  async recordAttachment(params: any): Promise<{ attachment: { id: string }; isDuplicate: boolean }> {
    const key = `${params.messageEventId}:${params.sha256}`;
    const existing = this.attachments.get(key);
    if (existing) {
      return { attachment: existing, isDuplicate: true };
    }
    const attachment = { id: crypto.randomUUID(), ...params, created_at: new Date() };
    this.attachments.set(key, attachment);
    return { attachment, isDuplicate: false };
  }

  async findTaskByMessageExternal(params: any): Promise<{ id: string; state: string; current_brief_id: string | null } | null> {
    for (const task of this.tasks.values()) {
      if (task.externalMessageId === params.externalMessageId) {
        return { id: task.id, state: task.state, current_brief_id: task.current_brief_id || null };
      }
    }
    return null;
  }

  async createTaskAggregate(params: any): Promise<{ task: { id: string; state: string }; created: boolean }> {
    const existing = Array.from(this.tasks.values()).find(t => t.idempotencyKey === params.idempotencyKey);
    if (existing) {
      return { task: existing, created: false };
    }
    const task = {
      id: crypto.randomUUID(),
      tenantId: params.tenantId,
      title: params.title,
      description: params.description,
      state: 'received',
      clientId: params.clientId,
      sourceMessageId: params.sourceMessageId,
      idempotencyKey: params.idempotencyKey,
      externalMessageId: params.payload?.envelope?.source?.messageId,
      current_brief_id: null,
      created_at: new Date(),
    };
    this.tasks.set(task.id, task);
    return { task, created: true };
  }

  async recordRevisionRequest(params: any): Promise<void> {
    this.revisionRequests.push({ ...params, occurred_at: new Date() });
    const task = this.tasks.get(params.taskId);
    if (task) {
      task.state = 'revision_requested';
    }
  }

  async updateTaskDraft(params: any): Promise<void> {
    const task = this.tasks.get(params.taskId);
    if (task) {
      task.description = params.description;
      task.sourceMessageId = params.sourceMessageId;
    }
  }
}

