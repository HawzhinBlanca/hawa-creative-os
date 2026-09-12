import crypto from 'node:crypto';

export interface TelegramActionTokenPayload {
  tokenId: string;
  taskId: string;
  revisionId: string;
  action: 'approve' | 'revision';
  actorId: string; // The authorized Telegram user ID or external account ID
  createdAt: number;
  expiresAt: number;
  nonce: string;
}

export type ActionVerificationErrorCode =
  | 'EXPIRED'
  | 'REPLAY_DETECTED'
  | 'INVALID_SIGNATURE'
  | 'UNAUTHORIZED_ACTOR'
  | 'STALE_REVISION'
  | 'MALFORMED';

export interface ActionVerificationFailure {
  ok: false;
  code: ActionVerificationErrorCode;
  error: string;
}

export interface ActionVerificationSuccess {
  ok: true;
  payload: TelegramActionTokenPayload;
}

export type ActionVerificationResult = ActionVerificationSuccess | ActionVerificationFailure;

/**
 * Storage interface for Telegram durable offset persistence
 */
export interface TelegramOffsetStorage {
  getOffset(): Promise<number>;
  setOffset(offset: number): Promise<void>;
}

export class MemoryTelegramOffsetStorage implements TelegramOffsetStorage {
  private offset = 0;
  async getOffset(): Promise<number> {
    return this.offset;
  }
  async setOffset(offset: number): Promise<void> {
    this.offset = Math.max(this.offset, offset);
  }
}

/**
 * Manages cryptographically bound Telegram callback action tokens.
 * Enforces binding to task, revision, action, actor, expiry, and single-use nonces.
 */
export class TelegramActionTokenService {
  private activeTokens = new Map<string, TelegramActionTokenPayload>();
  private consumedTokens = new Map<string, { nonce: string; consumedAt: number }>();
  private consumedNonces = new Set<string>();
  private defaultSecret: string;

  constructor(secret?: string) {
    this.defaultSecret = secret || process.env.HAWA_ACTION_HMAC_SECRET || 'hawa_telegram_action_default_hmac_secret_2026';
  }

  private computeSignature(payload: TelegramActionTokenPayload, secret: string): string {
    const canonical = [
      payload.tokenId,
      payload.taskId,
      payload.revisionId,
      payload.action,
      payload.actorId,
      String(payload.expiresAt),
      payload.nonce,
    ].join(':');
    return crypto.createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 16);
  }

  /**
   * Generates a compact action token that fits within Telegram's 64-byte callback_data limit
   * Format: "act:<tokenId>:<signature16>" (approx. 32 bytes)
   */
  createToken(params: {
    taskId: string;
    revisionId: string;
    action: 'approve' | 'revision';
    actorId: string;
    expiresInMs?: number;
    secretKey?: string;
  }): { callbackData: string; token: TelegramActionTokenPayload } {
    const tokenId = `t_${crypto.randomBytes(6).toString('hex')}`;
    const nonce = crypto.randomUUID();
    const now = Date.now();
    const expiresInMs = params.expiresInMs ?? 24 * 60 * 60 * 1000; // 24 hours default
    const expiresAt = now + expiresInMs;

    const payload: TelegramActionTokenPayload = {
      tokenId,
      taskId: params.taskId,
      revisionId: params.revisionId,
      action: params.action,
      actorId: String(params.actorId),
      createdAt: now,
      expiresAt,
      nonce,
    };

    const secret = params.secretKey || this.defaultSecret;
    const signature = this.computeSignature(payload, secret);

    this.activeTokens.set(tokenId, payload);

    // callback_data: e.g. "act:t_4f9a0c1b2e3d:a1b2c3d4e5f60718"
    const callbackData = `act:${tokenId}:${signature}`;

    return { callbackData, token: payload };
  }

  /**
   * Verifies an inbound Telegram callback query data string.
   * Prevents replay attacks, rejects expired tokens, enforces revision matching and verifies actor identity.
   */
  verifyAndConsumeToken(
    callbackData: string,
    context: {
      actorId: string; // The user who pressed the button in Telegram (from.id)
      currentRevisionId?: string;
      secretKey?: string;
      allowedActors?: string[];
    }
  ): ActionVerificationResult {
    if (!callbackData || typeof callbackData !== 'string') {
      return { ok: false, code: 'MALFORMED', error: 'Missing or malformed callback data' };
    }

    const parts = callbackData.split(':');
    if (parts.length !== 3 || parts[0] !== 'act') {
      return { ok: false, code: 'MALFORMED', error: 'Invalid callback action token format' };
    }

    const [, tokenId, signature] = parts;
    if (this.consumedTokens.has(tokenId)) {
      return { ok: false, code: 'REPLAY_DETECTED', error: `Action token ${tokenId} has already been consumed (replay attack detected)` };
    }
    const token = this.activeTokens.get(tokenId);
    if (!token) {
      return { ok: false, code: 'MALFORMED', error: `Unknown or expired action token ID: ${tokenId}` };
    }

    // 1. Verify signature
    const secret = context.secretKey || this.defaultSecret;
    const expectedSig = this.computeSignature(token, secret);
    const bufExpected = Buffer.from(expectedSig);
    const bufProvided = Buffer.from(signature);
    if (bufExpected.length !== bufProvided.length || !crypto.timingSafeEqual(bufExpected, bufProvided)) {
      return { ok: false, code: 'INVALID_SIGNATURE', error: 'Action token HMAC signature mismatch' };
    }

    // 2. Check Expiry
    if (Date.now() > token.expiresAt) {
      this.activeTokens.delete(tokenId);
      return { ok: false, code: 'EXPIRED', error: `Action token expired at ${new Date(token.expiresAt).toISOString()}` };
    }

    // 3. Check Nonce (Replay Attack Defense)
    if (this.consumedNonces.has(token.nonce)) {
      return { ok: false, code: 'REPLAY_DETECTED', error: `Action token nonce ${token.nonce} has already been consumed` };
    }

    // 4. Check Actor Authorization ("Unknown users cannot approve")
    const incomingActor = String(context.actorId);
    const isOwner = token.actorId === '*' || token.actorId === incomingActor;
    const isAllowedOverride = context.allowedActors && context.allowedActors.includes(incomingActor);
    if (!isOwner && !isAllowedOverride) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_ACTOR',
        error: `User ${incomingActor} is not authorized to execute this action (assigned to ${token.actorId})`,
      };
    }

    // 5. Check Revision Staleness (if current revision provided)
    if (context.currentRevisionId && context.currentRevisionId !== token.revisionId) {
      return {
        ok: false,
        code: 'STALE_REVISION',
        error: `Action token was generated for revision ${token.revisionId}, but current task revision is ${context.currentRevisionId}`,
      };
    }

    // Consume nonce and token (single-use guarantee)
    this.consumedTokens.set(tokenId, { nonce: token.nonce, consumedAt: Date.now() });
    this.consumedNonces.add(token.nonce);
    this.activeTokens.delete(tokenId);

    return { ok: true, payload: token };
  }

  /**
   * Resets active token and consumed nonce caches (useful for isolated tests)
   */
  clear(): void {
    this.activeTokens.clear();
    this.consumedTokens.clear();
    this.consumedNonces.clear();
  }
}

export interface TelegramMiniAppUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TelegramMiniAppData {
  queryId?: string;
  user: TelegramMiniAppUser;
  authDate: Date;
  hash: string;
}

/**
 * Server-side verification for Telegram Mini App (Web App) initData.
 * Implements standard Telegram cryptographic validation:
 * HMAC-SHA256(data_check_string, HMAC-SHA256("WebAppData", botToken))
 */
export function verifyTelegramMiniAppInitData(
  initData: string,
  botToken: string,
  options?: { maxAgeSeconds?: number }
): { ok: true; value: TelegramMiniAppData } | { ok: false; error: string } {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, error: 'Empty or missing Telegram Web App initData' };
  }
  if (!botToken) {
    return { ok: false, error: 'Bot token required for Mini App verification' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      return { ok: false, error: 'Missing hash in initData' };
    }

    params.delete('hash');

    // Build data-check-string with alphabetically sorted keys
    const entries: string[] = [];
    params.forEach((value, key) => {
      entries.push(`${key}=${value}`);
    });
    entries.sort();
    const dataCheckString = entries.join('\n');

    // Secret key = HMAC_SHA256("WebAppData", botToken)
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

    // Computed hash = HMAC_SHA256(dataCheckString, secretKey)
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const bufComputed = Buffer.from(computedHash);
    const bufProvided = Buffer.from(hash);
    if (bufComputed.length !== bufProvided.length || !crypto.timingSafeEqual(bufComputed, bufProvided)) {
      return { ok: false, error: 'Telegram Mini App initData cryptographic hash signature mismatch' };
    }

    const authDateSeconds = parseInt(params.get('auth_date') || '0', 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maxAge = options?.maxAgeSeconds ?? 86400; // 24 hours default

    if (nowSeconds - authDateSeconds > maxAge) {
      return { ok: false, error: `Telegram Mini App initData is stale (older than ${maxAge}s)` };
    }

    const userRaw = params.get('user');
    if (!userRaw) {
      return { ok: false, error: 'Missing user payload in initData' };
    }

    const user = JSON.parse(userRaw) as TelegramMiniAppUser;
    return {
      ok: true,
      value: {
        queryId: params.get('query_id') || undefined,
        user,
        authDate: new Date(authDateSeconds * 1000),
        hash,
      },
    };
  } catch (err: any) {
    return { ok: false, error: `Failed to verify Mini App initData: ${err.message}` };
  }
}
