/**
 * Hawa Creative OS — Two-Way Outbound Approval Dispatcher
 * Formats and dispatches interactive review messages to WhatsApp (WAHA) & Telegram channels
 * with cryptographic callback verification and state machine event triggers.
 */

import crypto from 'node:crypto';

export interface CampaignReviewDispatchPayload {
  taskId: string;
  clientId: string;
  clientName: string;
  recipientPhone: string;
  headlineCkb: string;
  headlineEn: string;
  copyCkb: string;
  copyEn: string;
  brandName: string;
  formats: ('story' | 'feed' | 'square' | 'landscape')[];
  previewUrls?: {
    story?: string;
    feed?: string;
    square?: string;
    landscape?: string;
  };
  callbackBaseUrl?: string;
}

export interface InteractiveActionDescriptor {
  actionId: string;
  action: 'approve' | 'revision';
  labelCkb: string;
  labelEn: string;
  callbackUrl: string;
  signature: string;
}

export interface OutboundDispatchReceipt {
  dispatchId: string;
  taskId: string;
  clientId: string;
  recipientPhone: string;
  messageText: string;
  actions: InteractiveActionDescriptor[];
  idempotencyKey: string;
  dispatchedAt: string;
  status: 'SENT' | 'QUEUED';
}

export interface InboundActionPayload {
  taskId: string;
  clientId: string;
  action: 'approve' | 'revision';
  signature: string;
  feedbackNotes?: string;
  senderPhone: string;
}

/**
 * Computes deterministic HMAC signature for an interactive action to prevent tampering.
 */
export function computeActionSignature(taskId: string, action: string, secretKey = 'hawa_safe_secret_key'): string {
  return crypto
    .createHmac('sha256', secretKey)
    .update(`${taskId}:${action}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Validates the inbound callback signature.
 */
export function verifyActionSignature(
  taskId: string,
  action: string,
  providedSignature: string,
  secretKey = 'hawa_safe_secret_key'
): boolean {
  const expected = computeActionSignature(taskId, action, secretKey);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSignature));
  } catch {
    return false;
  }
}

/**
 * Builds formatted bilingual review message with action descriptors.
 */
export function buildOutboundReviewDispatch(
  payload: CampaignReviewDispatchPayload,
  secretKey = 'hawa_safe_secret_key'
): OutboundDispatchReceipt {
  const dispatchId = `disp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const baseUrl = payload.callbackBaseUrl || 'http://localhost:3001';

  const approveSig = computeActionSignature(payload.taskId, 'approve', secretKey);
  const revisionSig = computeActionSignature(payload.taskId, 'revision', secretKey);

  const actions: InteractiveActionDescriptor[] = [
    {
      actionId: `act_approve_${payload.taskId}`,
      action: 'approve',
      labelCkb: '✅ پەسەندکردن و بڵاوکردنەوە',
      labelEn: 'Approve & Publish',
      callbackUrl: `${baseUrl}/api/webhooks/whatsapp/actions?taskId=${payload.taskId}&action=approve&sig=${approveSig}&phone=${encodeURIComponent(payload.recipientPhone)}`,
      signature: approveSig,
    },
    {
      actionId: `act_revision_${payload.taskId}`,
      action: 'revision',
      labelCkb: '✏️ داواکاری چاککردنەوە',
      labelEn: 'Request Revision',
      callbackUrl: `${baseUrl}/api/webhooks/whatsapp/actions?taskId=${payload.taskId}&action=revision&sig=${revisionSig}&phone=${encodeURIComponent(payload.recipientPhone)}`,
      signature: revisionSig,
    },
  ];

  const formatList = payload.formats.map((f) => {
    if (f === 'story') return '📱 Story (9:16)';
    if (f === 'feed') return '🖼️ Feed (4:5)';
    if (f === 'square') return '◻️ Square (1:1)';
    return '🖥️ Landscape (16:9)';
  }).join(' · ');

  const messageText = `✨ *کەمپینی نوێ ئامادەیە بۆ پێداچوونەوە*
🏢 *کڕیار / Client:* ${payload.brandName} (${payload.clientName})
📋 *ناسنامەی کار / Task ID:* \`${payload.taskId}\`

📢 *سەردێڕی پەسەندکراو / Headline:*
${payload.headlineCkb}
_${payload.headlineEn}_

📝 *دەقی ڕیکلام / Copy:*
${payload.copyCkb}
_${payload.copyEn}_

📐 *فۆرماتە ئامادەکراوەکان / Generated Formats (4-in-1):*
${formatList}

───────────────────────────────
بۆ پەسەندکردن یان داواکاری گۆڕانکاری کلیک لە دوگمەکانی خوارەوە بکە:
To approve or request adjustments:

1️⃣ پەسەندکردن / Approve:
${actions[0].callbackUrl}

2️⃣ داواکاری دەستکاری / Request Revision:
${actions[1].callbackUrl}`;

  return {
    dispatchId,
    taskId: payload.taskId,
    clientId: payload.clientId,
    recipientPhone: payload.recipientPhone,
    messageText,
    actions,
    idempotencyKey: `idem_disp_${payload.taskId}`,
    dispatchedAt: new Date().toISOString(),
    status: 'SENT',
  };
}
