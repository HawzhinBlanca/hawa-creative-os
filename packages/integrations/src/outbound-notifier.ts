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
  /** The clock the links' expiry is set from (tests pass a fixed one). */
  now?: number;
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

/**
 * A review link (ADR-159). The link itself only opens a confirmation page: a GET never approves or
 * publishes, since link-preview bots fetch every link a chat shows. The confirmation POSTs the same
 * claims. The signature covers the task, the action, whether it publishes, the expiry and the phone
 * it was sent to, so none of them can be changed in the address.
 */
export const ACTION_LINK_TTL_MS = 72 * 3_600_000;
export interface ActionLinkClaims {
  taskId: string;
  action: 'approve' | 'revision';
  publish: boolean;
  /** Unix seconds after which the link is refused. */
  exp: number;
  phone?: string;
}
const linkText = (c: ActionLinkClaims) => `v2:${c.taskId}:${c.action}:${c.publish ? 1 : 0}:${c.exp}:${c.phone ?? ''}`;
function actionKey(secretKey?: string): string {
  const key = secretKey || process.env.HAWA_ACTION_HMAC_SECRET;
  if (!key) throw new Error('HAWA_ACTION_HMAC_SECRET is not configured; action signatures cannot be produced or verified');
  return key;
}
export function signActionLink(claims: ActionLinkClaims, secretKey?: string): string {
  return crypto.createHmac('sha256', actionKey(secretKey)).update(linkText(claims)).digest('hex');
}
/** True only for this exact claim set, signed, and not yet expired at `now`. */
export function verifyActionLink(claims: ActionLinkClaims, signature: unknown, now = Date.now(), secretKey?: string):
  'valid' | 'invalid' | 'expired' {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature) || !Number.isSafeInteger(claims.exp)) return 'invalid';
  const expected = Buffer.from(signActionLink(claims, secretKey)), given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return 'invalid';
  return claims.exp * 1000 <= now ? 'expired' : 'valid';
}
export function actionLinkQuery(claims: ActionLinkClaims, signature: string): string {
  const q = new URLSearchParams({ taskId: claims.taskId, action: claims.action, publish: claims.publish ? 'true' : 'false',
    exp: String(claims.exp), sig: signature });
  if (claims.phone) q.set('phone', claims.phone);
  return q.toString();
}

/**
 * Computes deterministic HMAC signature for an interactive action to prevent tampering.
 */
export function computeActionSignature(taskId: string, action: string, secretKey?: string): string {
  const key = secretKey || process.env.HAWA_ACTION_HMAC_SECRET;
  if (!key) throw new Error('HAWA_ACTION_HMAC_SECRET is not configured; action signatures cannot be produced or verified');
  return crypto
    .createHmac('sha256', key)
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
  secretKey?: string
): boolean {
  if (!providedSignature || typeof providedSignature !== 'string') return false;
  const key = secretKey || process.env.HAWA_ACTION_HMAC_SECRET;
  if (!key) throw new Error('HAWA_ACTION_HMAC_SECRET is not configured; action signatures cannot be produced or verified');
  try {
    const expected = computeActionSignature(taskId, action, key);
    const targetExpected = providedSignature.length === 16 ? expected.slice(0, 16) : expected;
    const bufExpected = Buffer.from(targetExpected);
    const bufProvided = Buffer.from(providedSignature);
    if (bufExpected.length !== bufProvided.length) return false;
    return crypto.timingSafeEqual(bufExpected, bufProvided);
  } catch {
    return false;
  }
}

/**
 * Builds formatted bilingual review message with action descriptors.
 */
export function buildOutboundReviewDispatch(
  payload: CampaignReviewDispatchPayload,
  secretKey?: string
): OutboundDispatchReceipt {
  const dispatchId = `disp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const baseUrl = payload.callbackBaseUrl || 'http://localhost:3001';

  const exp = Math.floor(((payload.now ?? Date.now()) + ACTION_LINK_TTL_MS) / 1000);
  const approve: ActionLinkClaims = { taskId: payload.taskId, action: 'approve', publish: false, exp, phone: payload.recipientPhone };
  const revision: ActionLinkClaims = { ...approve, action: 'revision' };
  const approveSig = signActionLink(approve, secretKey);
  const revisionSig = signActionLink(revision, secretKey);

  const actions: InteractiveActionDescriptor[] = [
    {
      actionId: `act_approve_${payload.taskId}`,
      action: 'approve',
      labelCkb: '✅ پەسەندکردن و بڵاوکردنەوە',
      labelEn: 'Approve & Publish',
      callbackUrl: `${baseUrl}/api/webhooks/whatsapp/actions?${actionLinkQuery(approve, approveSig)}`,
      signature: approveSig,
    },
    {
      actionId: `act_revision_${payload.taskId}`,
      action: 'revision',
      labelCkb: '✏️ داواکاری چاککردنەوە',
      labelEn: 'Request Revision',
      callbackUrl: `${baseUrl}/api/webhooks/whatsapp/actions?${actionLinkQuery(revision, revisionSig)}`,
      signature: revisionSig,
    },
  ];

  const formatList = payload.formats.map((f) => {
    if (f === 'story') return '📱 Story (9:16)';
    if (f === 'feed') return '🖼️ Feed (4:5)';
    if (f === 'square') return '◻️ Square (1:1)';
    return '🖥️ Landscape (16:9)';
  }).join(' · ');

  // Only copy the client sent is shown: an empty line, or a section with nothing in it, is left out.
  const pair = (ckb: string, en: string) => [ckb, en && `_${en}_`].filter(Boolean).join('\n');
  const headline = pair(payload.headlineCkb, payload.headlineEn);
  const copy = pair(payload.copyCkb, payload.copyEn);
  const copySections = [
    headline && `📢 *سەردێڕی پەسەندکراو / Headline:*\n${headline}\n\n`,
    copy && `📝 *دەقی ڕیکلام / Copy:*\n${copy}\n\n`,
  ].filter(Boolean).join('');

  const messageText = `✨ *کەمپینی نوێ ئامادەیە بۆ پێداچوونەوە*
🏢 *کڕیار / Client:* ${payload.brandName} (${payload.clientName})
📋 *ناسنامەی کار / Task ID:* \`${payload.taskId}\`

${copySections}📐 *فۆرماتە ئامادەکراوەکان / Generated Formats (4-in-1):*
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
