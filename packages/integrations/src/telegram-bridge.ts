export interface TelegramBridgeConfig {
  botToken?: string;
  targetIngressUrl?: string;
  /** Bound on one file download (getFile plus the file body). Defaults to 60 s. */
  downloadTimeoutMs?: number;
  /** Bound on one file upload (sendDocument). Defaults to 60 s. */
  fileUploadTimeoutMs?: number;
}

/** Default bound on one Telegram file transfer, in either direction. */
export const TELEGRAM_FILE_TRANSFER_TIMEOUT_MS = 60_000;
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** Count actual streamed bytes, even when Content-Length is absent or misleading. */
async function boundedTelegramBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => undefined); throw new Error('Telegram response exceeds the byte limit');
  }
  if (!response.body) throw new Error('Telegram response has no body');
  const reader = response.body.getReader();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Telegram download timed out'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), cancelled]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Telegram response exceeds the byte limit');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    // Cancellation itself must not let a broken remote stream hold intake indefinitely.
    void reader.cancel().catch(() => undefined);
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
    };
    date: number;
    text?: string;
    voice?: {
      file_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
    };
    audio?: {
      file_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
      title?: string;
    };
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
        type: string;
        title?: string;
      };
      text?: string;
    };
    data?: string;
  };
}

export interface TelegramOutboundMessage {
  text: string;
  parse_mode?: string;
  reply_markup?: any;
}

/**
 * Escapes text for Telegram `parse_mode: 'HTML'`. User-controlled strings (sender names,
 * titles, copy) must always pass through this; otherwise a single `<` or `&` makes Telegram
 * reject the whole message with HTTP 400 and the requester hears nothing.
 */
export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Escapes text for Telegram legacy `parse_mode: 'Markdown'`.
 * Neutralises `_`, `*`, `` ` ``, and `[` so user content cannot break entity parsing.
 */
export function escapeTelegramMarkdown(value: unknown): string {
  return String(value ?? '').replace(/([_*`\[])/g, '\\$1');
}

/** Telegram's limits in UTF-16 units: a message's text, and a photo's or document's caption. */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
const SHORTENED_NOTE = '\n…(shortened)';

/** HTML tags opened in `html` and not closed, innermost last. */
function unclosedHtmlTags(html: string): string[] {
  const open: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*>/g)) {
    const name = m[2].toLowerCase();
    if (!m[1]) open.push(name);
    else {
      const at = open.lastIndexOf(name);
      if (at !== -1) open.splice(at, 1);
    }
  }
  return open;
}

/**
 * Text cut to Telegram's `limit`. Telegram refuses a longer message outright ("message is too
 * long"), the plain-text retry was refused the same way, and callers ignore success:false, so the
 * message vanished (2026-09-23). The cut falls at a line break where one is near, never inside an
 * HTML tag or entity, and closes the HTML tags it leaves open; the result fits with its tags
 * counted, so the plain-text retry, which sends the same text, fits too.
 */
export function fitTelegramText(text: string, limit: number, parseMode?: string): string {
  if (text.length <= limit) return text;
  const html = parseMode?.toUpperCase() === 'HTML';
  let budget = limit - SHORTENED_NOTE.length;
  while (budget > 0) {
    let cut = text.slice(0, budget);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never half an emoji
    const lineBreak = cut.lastIndexOf('\n');
    if (lineBreak >= budget / 2) cut = cut.slice(0, lineBreak);
    if (!html) return `${cut}${SHORTENED_NOTE}`;
    cut = cut.replace(/<[^>]*$/, '').replace(/&#?[a-zA-Z0-9]*$/, '');
    const fitted = `${cut}${unclosedHtmlTags(cut).reverse().map((tag) => `</${tag}>`).join('')}${SHORTENED_NOTE}`;
    if (fitted.length <= limit) return fitted;
    budget -= fitted.length - limit;
  }
  return SHORTENED_NOTE.trimStart();
}

export interface BridgeStatus {
  active: boolean;
  mode: 'live_polling' | 'offline_daemon' | 'webhook_push';
  lastUpdateId: number;
  processedCount: number;
  ingressUrl: string;
  uptimeSeconds: number;
  webhookActive?: boolean;
  webhookUrl?: string;
  degraded?: boolean;
  lastPollAttemptAt?: string;
  lastPollSuccessAt?: string;
  lastError?: { code: string; message: string; timestamp: string };
  /** The office kill switch is on: nothing is fetched from Telegram and nothing is processed. */
  intakePaused?: boolean;
}

/**
 * What a send to Telegram came to. On a 429 Telegram names how long to wait
 * (`parameters.retry_after`, seconds), carried as `retryAfterSeconds` so a sender can wait exactly
 * that long (PHASE2_DESIGN.md 2.6); the error code itself is unchanged, since the outbox reads it.
 */
export interface TelegramSendOutcome {
  success: boolean;
  messageId?: string;
  error?: string;
  retryAfterSeconds?: number;
}

/** Telegram's retry_after on a 429, when it gave one. */
function retryAfterOf(res: Response, body: { error_code?: number; parameters?: { retry_after?: unknown } } | null): { retryAfterSeconds?: number } {
  if (res.status !== 429 && body?.error_code !== 429) return {};
  const seconds = Number(body?.parameters?.retry_after);
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : {};
}

/** A send may have committed when HTTP succeeds without a definite API result, or a server fails. */
function ambiguousOutboundResponse(res: Response, body: { ok?: boolean; error_code?: number } | null): boolean {
  return res.status >= 500 || Number(body?.error_code) >= 500 ||
    (res.ok && body?.ok !== true && !Number.isInteger(body?.error_code));
}

export class TelegramBridgeDaemon {
  private startTime = Date.now();
  private sentMessages: Array<{ chatId: string | number; text: string; replyMarkup?: any; sentAt: string }> = [];
  private webhookActive = false;
  private webhookUrl = '';

  constructor(private readonly config: TelegramBridgeConfig = {}) {}

  /**
   * Downloads an audio or voice file buffer from Telegram Bot API via getFile
   */
  async downloadFile(fileId: string): Promise<Buffer | null> {
    if (!this.config.botToken || typeof fileId !== 'string' || !fileId.trim() || fileId.length > 512) return null;
    try {
      // One deadline covers getFile, the file request and reading its body. Without it a single
      // stalled download held the intake that awaited it indefinitely.
      const signal = AbortSignal.timeout(this.config.downloadTimeoutMs ?? TELEGRAM_FILE_TRANSFER_TIMEOUT_MS);
      const getFileUrl = `https://api.telegram.org/bot${this.config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
      const res = await fetch(getFileUrl, { signal, redirect: 'error' });
      if (!res.ok) return null;
      const data = JSON.parse((await boundedTelegramBody(res, 64 * 1024, signal)).toString('utf8'));
      if (!data.ok || !data.result?.file_path) return null;
      const filePath = data.result.file_path;
      if (typeof filePath !== 'string' || filePath.length > 1024 ||
          !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(filePath) ||
          filePath.split('/').some(part => part === '.' || part === '..')) return null;
      if (data.result.file_size !== undefined && (!Number.isSafeInteger(data.result.file_size) ||
          data.result.file_size < 1 || data.result.file_size > TELEGRAM_DOWNLOAD_MAX_BYTES)) return null;
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${data.result.file_path}`;
      const fileRes = await fetch(fileUrl, { signal, redirect: 'error' });
      if (!fileRes.ok) return null;
      const bytes = await boundedTelegramBody(fileRes, TELEGRAM_DOWNLOAD_MAX_BYTES, signal);
      return bytes.length ? bytes : null;
    } catch {
      // Transport errors can include the credential-bearing Telegram URL.
      console.warn('[TelegramBridge] File download unavailable');
      return null;
    }
  }

  /**
   * Removes webhook registration and optionally reverts to long polling
   */
  async deleteWebhook(dropPendingUpdates = false): Promise<{ ok: boolean; description?: string }> {
    if (!this.config.botToken || this.config.botToken.startsWith('mock-')) {
      this.webhookActive = false;
      this.webhookUrl = '';
      return { ok: true, description: 'Webhook deleted (sandbox / mock mode)' };
    }
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/deleteWebhook?drop_pending_updates=${dropPendingUpdates}`;
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        this.webhookActive = false;
        this.webhookUrl = '';
      }
      return data;
    } catch (err: any) {
      return { ok: false, description: err.message };
    }
  }

  /**
   * Inspects current webhook status from Telegram Bot API
   */
  async getWebhookInfo(): Promise<any> {
    if (!this.config.botToken || this.config.botToken.startsWith('mock-')) {
      return {
        ok: true,
        result: {
          url: this.webhookUrl,
          has_custom_certificate: false,
          pending_update_count: 0,
        },
      };
    }
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/getWebhookInfo`;
      const res = await fetch(url);
      return await res.json();
    } catch (err: any) {
      return { ok: false, description: err.message };
    }
  }

  /**
   * What Settings shows about the bot. Core never polls Telegram (ADR-135): the worker's poller
   * does, and reports its own state. The polling fields stay in the shape the Desk reads, empty;
   * the loop that filled them had no production caller and was removed (ADR-159).
   */
  getStatus(): BridgeStatus {
    return {
      active: this.webhookActive,
      mode: this.webhookActive ? 'webhook_push' : (this.config.botToken ? 'live_polling' : 'offline_daemon'),
      lastUpdateId: 0,
      processedCount: 0,
      ingressUrl: this.webhookUrl || this.config.targetIngressUrl || 'http://127.0.0.1:8080/api/webhooks/telegram',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      webhookActive: this.webhookActive,
      webhookUrl: this.webhookUrl,
      degraded: false,
      intakePaused: false,
    };
  }

  getSentMessages() {
    return [...this.sentMessages];
  }

  private recordSentMessage(msg: { chatId: string | number; text: string; replyMarkup?: any; sentAt: string }) {
    this.sentMessages.push(msg);
    if (this.sentMessages.length > 500) {
      this.sentMessages.splice(0, this.sentMessages.length - 500);
    }
  }

  clearSentMessages() {
    this.sentMessages = [];
  }

  /**
   * Acknowledges a Telegram callback query with optional notification toast
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    if (!this.config.botToken) return true;
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/answerCallbackQuery`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
          show_alert: showAlert,
        }),
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  private isPreConnectionError(error: unknown): boolean {
    if (!error) return false;
    const err = error as any;
    const code = err?.cause?.code || err?.code;
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      return true;
    }
    const msg = String(err?.cause?.message || err?.message || '');
    if (/getaddrinfo (ENOTFOUND|EAI_AGAIN)/i.test(msg) || /connect ECONNREFUSED/i.test(msg) || /network is unreachable/i.test(msg)) {
      return true;
    }
    return false;
  }

  /**
   * Dispatches an outbound message to a Telegram chat
   */
  async dispatchOutboundMessage(
    chatId: string | number,
    message: { text: string; parse_mode?: string; reply_markup?: any }
  ): Promise<TelegramSendOutcome> {
    if (!this.config.botToken) return { success: false, error: 'TELEGRAM_NOT_CONFIGURED' };
    const text = fitTelegramText(message.text, TELEGRAM_TEXT_LIMIT, message.parse_mode);
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(message.parse_mode ? {parse_mode: message.parse_mode} : {}),
          ...(message.reply_markup ? {reply_markup: message.reply_markup} : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => null) as any;
      if (!res.ok || body?.ok !== true) {
        if (ambiguousOutboundResponse(res, body)) {
          return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
        }
        // If entity parsing failed in Markdown mode, retry once as plain text
        if (message.parse_mode && body?.description?.includes('can\'t parse entities')) {
          const retryRes = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              ...(message.reply_markup ? {reply_markup: message.reply_markup} : {}),
            }),
            signal: AbortSignal.timeout(15000),
          });
          const retryBody = await retryRes.json().catch(() => null) as any;
          if (retryRes.ok && retryBody?.ok === true) {
            if (!Number.isSafeInteger(retryBody.result?.message_id) || retryBody.result.message_id <= 0 ||
                String(retryBody.result?.chat?.id) !== String(chatId)) {
              return { success: false, error: 'TELEGRAM_RECEIPT_INVALID' };
            }
            this.recordSentMessage({chatId, text, replyMarkup: message.reply_markup, sentAt: new Date().toISOString()});
            return { success: true, messageId: String(retryBody.result.message_id) };
          }
          if (ambiguousOutboundResponse(retryRes, retryBody)) {
            return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
          }
          return { success: false, error: `TELEGRAM_REJECTED_${retryBody?.error_code || retryRes.status}`,
            ...retryAfterOf(retryRes, retryBody) };
        }
        return { success: false, error: `TELEGRAM_REJECTED_${body?.error_code || res.status}`, ...retryAfterOf(res, body) };
      }
      if (!Number.isSafeInteger(body.result?.message_id) || body.result.message_id <= 0 ||
          String(body.result?.chat?.id) !== String(chatId)) {
        return { success: false, error: 'TELEGRAM_RECEIPT_INVALID' };
      }
      this.recordSentMessage({chatId, text, replyMarkup: message.reply_markup, sentAt: new Date().toISOString()});
      return { success: true, messageId: String(body.result.message_id) };
    } catch (err: unknown) {
      if (this.isPreConnectionError(err)) {
        return { success: false, error: 'TELEGRAM_NETWORK_ERROR' };
      }
      // A lost response can follow a successful send. Never automatically resend it.
      return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
    }
  }

  /**
   * Dispatches an outbound image with caption and action buttons to a Telegram chat
   */
  async dispatchOutboundPhoto(
    chatId: string | number,
    photoBuffer: Buffer,
    caption?: string,
    replyMarkup?: any
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.config.botToken) return { success: false, error: 'TELEGRAM_NOT_CONFIGURED' };
    if (!photoBuffer || !Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0) {
      return { success: false, error: 'INVALID_PHOTO_BUFFER' };
    }
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendPhoto`;
      const blob = new Blob([new Uint8Array(photoBuffer)], { type: 'image/png' });
      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      formData.append('photo', blob, 'design.png');
      // Cut before escaping: Telegram counts the caption after entity parsing, which drops the
      // escapes, and the plain fallback below sends this same cut text unescaped.
      const safeCaption = caption ? fitTelegramText(caption, TELEGRAM_CAPTION_LIMIT) : '';
      if (caption) {
        formData.append('caption', escapeTelegramMarkdown(safeCaption));
        formData.append('parse_mode', 'Markdown');
      }
      if (replyMarkup) {
        formData.append('reply_markup', typeof replyMarkup === 'string' ? replyMarkup : JSON.stringify(replyMarkup));
      }
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json().catch(() => null) as any;
      if (res.ok && body?.ok === true) {
        if (!Number.isSafeInteger(body.result?.message_id) || body.result.message_id <= 0 ||
            String(body.result?.chat?.id) !== String(chatId)) {
          return { success: false, error: 'TELEGRAM_RECEIPT_INVALID' };
        }
        return { success: true, messageId: String(body.result.message_id) };
      }
      if (ambiguousOutboundResponse(res, body)) {
        return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
      }
      // Only a definite parse rejection makes a second send safe.
      if (caption && body?.description?.includes('can\'t parse entities')) {
        const fallbackForm = new FormData();
        fallbackForm.append('chat_id', String(chatId));
        fallbackForm.append('photo', blob, 'design.png');
        // The uncut caption went here, so a long caption was refused a second time.
        fallbackForm.append('caption', safeCaption.replace(/[*_`\[\]()]/g, ''));
        if (replyMarkup) fallbackForm.append('reply_markup', typeof replyMarkup === 'string' ? replyMarkup : JSON.stringify(replyMarkup));
        const fbRes = await fetch(url, { method: 'POST', body: fallbackForm, signal: AbortSignal.timeout(20000) });
        const fbBody = await fbRes.json().catch(() => null) as any;
        if (fbRes.ok && fbBody?.ok === true) {
          if (!Number.isSafeInteger(fbBody.result?.message_id) || fbBody.result.message_id <= 0 ||
              String(fbBody.result?.chat?.id) !== String(chatId)) {
            return { success: false, error: 'TELEGRAM_RECEIPT_INVALID' };
          }
          return { success: true, messageId: String(fbBody.result.message_id) };
        }
        if (ambiguousOutboundResponse(fbRes, fbBody)) {
          return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
        }
        return { success: false, error: `TELEGRAM_PHOTO_FAILED_${fbBody?.error_code || fbRes.status}` };
      }
      return { success: false, error: `TELEGRAM_PHOTO_FAILED_${body?.error_code || res.status}` };
    } catch (err: unknown) {
      if (this.isPreConnectionError(err)) {
        return { success: false, error: 'TELEGRAM_NETWORK_ERROR' };
      }
      return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
    }
  }

  /**
   * Sends a file to a chat as a document (multipart sendDocument), so the recipient gets exactly the
   * bytes that were approved: Telegram recompresses anything sent as a photo. The upload is bounded by
   * a timeout. A failure after the request may have been written cannot tell whether Telegram kept the
   * file, so it is reported as uncertain and must not be resent automatically.
   */
  async dispatchOutboundDocument(
    chatId: string | number,
    fileBytes: Uint8Array,
    filename: string,
    options: { mimeType?: string; caption?: string; parseMode?: 'HTML' | 'Markdown'; timeoutMs?: number } = {}
  ): Promise<TelegramSendOutcome> {
    if (!this.config.botToken) return { success: false, error: 'TELEGRAM_NOT_CONFIGURED' };
    if (!fileBytes || fileBytes.length === 0) return { success: false, error: 'INVALID_DOCUMENT_BUFFER' };
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([new Uint8Array(fileBytes)], { type: options.mimeType || 'application/octet-stream' }), filename || 'file');
    if (options.caption) {
      // A blind slice could end inside an HTML tag or entity, which Telegram refuses outright.
      form.append('caption', fitTelegramText(options.caption, TELEGRAM_CAPTION_LIMIT, options.parseMode));
      if (options.parseMode) form.append('parse_mode', options.parseMode);
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.config.fileUploadTimeoutMs ?? TELEGRAM_FILE_TRANSFER_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error_code?: number; parameters?: { retry_after?: unknown }; result?: { message_id?: number; chat?: { id?: number | string } } } | null;
      if (ambiguousOutboundResponse(res, body)) {
        return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
      }
      if (!res.ok || body?.ok !== true || !body.result) {
        return { success: false, error: `TELEGRAM_DOCUMENT_REJECTED_${body?.error_code || res.status}`, ...retryAfterOf(res, body) };
      }
      if (!Number.isSafeInteger(body.result.message_id) || Number(body.result.message_id) <= 0 ||
          String(body.result?.chat?.id) !== String(chatId)) {
        return { success: false, error: 'TELEGRAM_RECEIPT_INVALID' };
      }
      return { success: true, messageId: String(body.result.message_id) };
    } catch (err: unknown) {
      if (this.isPreConnectionError(err)) {
        return { success: false, error: 'TELEGRAM_NETWORK_ERROR' };
      }
      return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
    }
  }
}

export const TelegramBridge = TelegramBridgeDaemon;
export type TelegramBridge = TelegramBridgeDaemon;
