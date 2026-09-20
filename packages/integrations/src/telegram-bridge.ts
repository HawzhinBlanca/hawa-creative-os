import { computeActionSignature, verifyActionSignature } from './outbound-notifier.js';
import type { TelegramOffsetStorage, TelegramActionTokenService } from './telegram-security.js';

export interface TelegramBridgeConfig {
  botToken?: string;
  secretToken?: string;
  targetIngressUrl?: string;
  deskBaseUrl?: string;
  pollIntervalMs?: number;
  offsetStorage?: TelegramOffsetStorage;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  actionTokenService?: TelegramActionTokenService;
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

export interface TelegramCommandResult extends TelegramOutboundMessage {
  action?: 'approve' | 'revision' | 'redrive';
  taskId?: string;
  notes?: string;
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

export function parseCallbackData(data: string): { action: 'approve' | 'revision'; taskId: string; signature: string } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length < 3) return null;
  const [act, taskId, signature] = parts;
  if (!signature || signature.trim() === '' || signature === 'short_bypass') return null;
  const action = act === 'app' || act === 'approve' ? 'approve' : act === 'rev' || act === 'revision' ? 'revision' : null;
  if (!action || !taskId) return null;
  return { action, taskId, signature: signature.trim() };
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
}

export class TelegramBridgeDaemon {
  private active = false;
  private lastUpdateId = 0;
  private processedCount = 0;
  private startTime = Date.now();
  private pollTimer?: NodeJS.Timeout;

  private abortController?: AbortController;
  private sentMessages: Array<{ chatId: string | number; text: string; replyMarkup?: any; sentAt: string }> = [];
  private webhookActive = false;
  private webhookUrl = '';

  private lastPollAttemptAt?: string;
  private lastPollSuccessAt?: string;
  private consecutiveErrors = 0;
  private lastError?: { code: string; message: string; timestamp: string };

  constructor(private readonly config: TelegramBridgeConfig = {}) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startTime = Date.now();
  }

  stop(): void {
    this.active = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Polls Telegram getUpdates endpoint once with offset tracking, bounded timeout, and truthful error reporting
   */
  async pollOnce(onUpdate?: (update: TelegramUpdate) => Promise<void>): Promise<number> {
    if (!this.config.botToken) return 0;
    if (this.lastUpdateId === 0 && this.config.offsetStorage) {
      try {
        this.lastUpdateId = await this.config.offsetStorage.getOffset();
      } catch (err) {
        console.warn('[TelegramBridge] Failed to load offset from storage:', err);
      }
    }
    this.lastPollAttemptAt = new Date().toISOString();
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5`;
      const timeoutSignal = AbortSignal.timeout(12000);
      const combinedSignal = this.abortController
        ? (AbortSignal as any).any([this.abortController.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(url, { signal: combinedSignal });
      if (!res.ok) {
        this.consecutiveErrors++;
        this.lastError = {
          code: `HTTP_${res.status}`,
          message: `Telegram API returned HTTP ${res.status}`,
          timestamp: new Date().toISOString(),
        };
        return 0;
      }
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        this.consecutiveErrors = 0;
        this.lastPollSuccessAt = new Date().toISOString();
        this.lastError = undefined;
        let count = 0;
        for (const update of data.result) {
          if (onUpdate) {
            await onUpdate(update);
          } else {
            await this.processUpdate(update);
          }
          // Telegram drops older updates after the next offset is sent. Advance
          // only after ingress has durably accepted (or explicitly rejected) it.
          const nextOffset = Math.max(this.lastUpdateId, update.update_id);
          if (this.config.offsetStorage) await this.config.offsetStorage.setOffset(nextOffset);
          this.lastUpdateId = nextOffset;
          count++;
          this.processedCount++;
        }
        return count;
      } else {
        this.consecutiveErrors++;
        this.lastError = {
          code: 'TELEGRAM_API_ERROR',
          message: data.description || 'Unknown Telegram API response',
          timestamp: new Date().toISOString(),
        };
      }
    } catch (err: any) {
      this.consecutiveErrors++;
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message?.includes('timeout');
      this.lastError = {
        code: isTimeout ? 'TELEGRAM_NETWORK_TIMEOUT' : 'TELEGRAM_FETCH_FAILED',
        message: err?.message || 'Transient network failure',
        timestamp: new Date().toISOString(),
      };
    }
    return 0;
  }

  /**
   * Starts a continuous long-polling background loop
   */
  async startPolling(onUpdate?: (update: TelegramUpdate) => Promise<void>): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.startTime = Date.now();

    const loop = async () => {
      while (this.active) {
        try {
          this.abortController = new AbortController();
          await this.pollOnce(onUpdate);
        } catch {
          // Continue polling loop on non-fatal error
        }
        if (!this.active) break;
        const backoff = this.consecutiveErrors > 0 ? Math.min(30000, 1000 * Math.pow(2, Math.min(5, this.consecutiveErrors))) : 800;
        await new Promise((r) => setTimeout(r, backoff));
      }
    };

    loop().catch(() => {});
  }

  /**
   * Downloads an audio or voice file buffer from Telegram Bot API via getFile
   */
  async downloadFile(fileId: string): Promise<Buffer | null> {
    if (!this.config.botToken) return null;
    try {
      const getFileUrl = `https://api.telegram.org/bot${this.config.botToken}/getFile?file_id=${fileId}`;
      const res = await fetch(getFileUrl);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.ok || !data.result?.file_path) return null;
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${data.result.file_path}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) return null;
      const arrayBuffer = await fileRes.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.warn('[TelegramBridge] Failed to download file:', err);
      return null;
    }
  }

  /**
   * Registers a public webhook with Telegram Bot API
   */
  async setWebhook(webhookUrl: string, secretToken?: string): Promise<{ ok: boolean; description?: string }> {
    if (!this.config.botToken || this.config.botToken.startsWith('mock-')) {
      this.webhookActive = true;
      this.webhookUrl = webhookUrl;
      this.stop();
      return { ok: true, description: 'Webhook registered (sandbox / mock mode)' };
    }
    try {
      const secret = secretToken || this.config.secretToken;
      const url = `https://api.telegram.org/bot${this.config.botToken}/setWebhook`;
      const body: any = {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query'],
      };
      if (secret) body.secret_token = secret;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        this.webhookActive = true;
        this.webhookUrl = webhookUrl;
        this.stop(); // Stop long-polling when webhook is active
      }
      return data;
    } catch (err: any) {
      return { ok: false, description: err.message };
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

  getStatus(): BridgeStatus {
    const degraded = this.consecutiveErrors >= 3;
    return {
      active: (this.active || this.webhookActive) && !degraded,
      mode: this.webhookActive ? 'webhook_push' : (this.config.botToken ? 'live_polling' : 'offline_daemon'),
      lastUpdateId: this.lastUpdateId,
      processedCount: this.processedCount,
      ingressUrl: this.webhookUrl || this.config.targetIngressUrl || 'http://127.0.0.1:8080/api/webhooks/telegram',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      webhookActive: this.webhookActive,
      webhookUrl: this.webhookUrl,
      degraded,
      lastPollAttemptAt: this.lastPollAttemptAt,
      lastPollSuccessAt: this.lastPollSuccessAt,
      lastError: this.lastError,
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
   * Formats a rich English Telegram preview card with deep link to Hawa Desk and interactive callback buttons
   */
  formatTaskPreviewCard(
    task: {
      id: string;
      docId?: string;
      title: string;
      copy?: string;
      status: string;
      clientName?: string;
      deskBaseUrl?: string;
      voiceTranscript?: string;
      revisionId?: string;
      actorId?: string;
      canvaDocumentId?: string;
      canvaUrl?: string;
    },
    secretKey?: string
  ) {
    const baseUrl =
      task.deskBaseUrl ||
      this.config.deskBaseUrl ||
      process.env.PUBLIC_TUNNEL_URL ||
      process.env.HAWA_PUBLIC_URL ||
      process.env.HAWA_DESK_BASE_URL ||
      'http://localhost:4173';
    const docParam = task.docId || task.id;
    const studioUrl = `${baseUrl}/review?doc=${docParam}&taskId=${task.id}&mode=review`;

    let approveCallbackData: string;
    let revisionCallbackData: string;

    if (this.config.actionTokenService) {
      const actor = task.actorId || '*';
      const rev = task.revisionId || 'rev_initial';
      const appToken = this.config.actionTokenService.createToken({
        taskId: task.id,
        revisionId: rev,
        action: 'approve',
        actorId: actor,
        secretKey,
      });
      const revToken = this.config.actionTokenService.createToken({
        taskId: task.id,
        revisionId: rev,
        action: 'revision',
        actorId: actor,
        secretKey,
      });
      approveCallbackData = appToken.callbackData;
      revisionCallbackData = revToken.callbackData;
    } else {
      const approveSig = computeActionSignature(task.id, 'approve', secretKey);
      const revisionSig = computeActionSignature(task.id, 'revision', secretKey);
      const isShortId = task.id.length <= 20;
      const approveAction = isShortId ? 'approve' : 'app';
      const revisionAction = isShortId ? 'revision' : 'rev';
      approveCallbackData = `${approveAction}:${task.id}:${approveSig.slice(0, 16)}`;
      revisionCallbackData = `${revisionAction}:${task.id}:${revisionSig.slice(0, 16)}`;
    }

    const esc = escapeTelegramMarkdown;
    const text = [
      `⚡ *Task Ready for Operator Review*`,
      ``,
      `🎯 *Title:* ${esc(task.title)}`,
      `🏢 *Client:* ${esc(task.clientName || 'Hawa Creative Office')}`,
      `📊 *Status:* \`${task.status.replace(/`/g, '')}\``,
      task.voiceTranscript ? `🎙️ *Spoken Voice Memo:* _"${esc(task.voiceTranscript)}"_` : null,
      task.copy ? `📝 *Approved Copy:* _${esc(task.copy)}_` : null,
      task.canvaDocumentId ? `🎨 *Canva Binding:* \`${task.canvaDocumentId.replace(/`/g, '')}\`` : null,
      ``,
      `🔍 *Desk Studio Link:*`,
      `${studioUrl}`,
    ]
      .filter(Boolean)
      .join('\n');

    const inlineKeyboard: any[][] = [
      [
        { text: '✅ Approve & Publish', callback_data: approveCallbackData },
        { text: '✏️ Request Revision', callback_data: revisionCallbackData },
      ],
      [
        { text: '⚡ Open Desk Studio', url: studioUrl },
        { text: '📋 View Evidence', url: `${baseUrl}/` },
      ],
    ];

    if (task.canvaUrl || task.canvaDocumentId) {
      const canvaLink = task.canvaUrl || `https://www.canva.com/design/${task.canvaDocumentId}/edit`;
      inlineKeyboard.push([
        { text: '🎨 Edit in Canva', url: canvaLink },
      ]);
    }

    return { text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
  }

  /**
   * Formats a publication receipt in English with Google Shared Drive links
   */
  formatPublicationNotice(task: {
    id: string;
    title: string;
    driveUrl: string;
    sheetUrl?: string;
    workflowId?: string;
  }) {
    const esc = escapeTelegramMarkdown;
    const text = [
      `✅ *Deliverables Approved & Published*`,
      ``,
      `🎯 *Task:* ${esc(task.title)}`,
      `📁 *Google Drive Folder:* ${task.driveUrl}`,
      task.sheetUrl ? `📊 *Google Sheets Audit Row:* ${task.sheetUrl}` : null,
      task.workflowId ? `🆔 *Restate Workflow ID:* \`${task.workflowId.replace(/`/g, '')}\`` : null,
      `⏰ *Delivered At:* ${new Date().toUTCString()}`,
    ]
      .filter(Boolean)
      .join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '📁 Open Drive Deliverables', url: task.driveUrl },
        ],
      ],
    };

    return { text, parse_mode: 'Markdown', reply_markup: replyMarkup };
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

  /**
   * Dispatches an outbound message to a Telegram chat
   */
  async dispatchOutboundMessage(
    chatId: string | number,
    message: { text: string; parse_mode?: string; reply_markup?: any }
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.config.botToken) return { success: false, error: 'TELEGRAM_NOT_CONFIGURED' };
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message.text,
          ...(message.parse_mode ? {parse_mode: message.parse_mode} : {}),
          ...(message.reply_markup ? {reply_markup: message.reply_markup} : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => null) as any;
      if (!res.ok || body?.ok !== true) {
        // If entity parsing failed in Markdown mode, retry once as plain text
        if (message.parse_mode && (body?.description?.includes('can\'t parse entities') || body?.error_code === 400)) {
          const retryRes = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message.text,
              ...(message.reply_markup ? {reply_markup: message.reply_markup} : {}),
            }),
            signal: AbortSignal.timeout(15000),
          });
          const retryBody = await retryRes.json().catch(() => null) as any;
          if (retryRes.ok && retryBody?.ok === true && Number.isSafeInteger(retryBody.result?.message_id)) {
            this.recordSentMessage({chatId, text: message.text, replyMarkup: message.reply_markup, sentAt: new Date().toISOString()});
            return { success: true, messageId: String(retryBody.result.message_id) };
          }
        }
        return { success: false, error: `TELEGRAM_REJECTED_${body?.error_code || res.status}` };
      }
      if (!Number.isSafeInteger(body.result?.message_id) || body.result.message_id <= 0 ||
          String(body.result?.chat?.id) !== String(chatId)) {
        return { success: false, error: 'TELEGRAM_RECEIPT_INVALID' };
      }
      this.recordSentMessage({chatId, text: message.text, replyMarkup: message.reply_markup, sentAt: new Date().toISOString()});
      return { success: true, messageId: String(body.result.message_id) };
    } catch {
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
      if (caption) {
        const safeCaption = caption.length > 1024 ? caption.slice(0, 1020) + '…' : caption;
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
      if (res.ok && body?.ok === true && Number.isSafeInteger(body.result?.message_id)) {
        return { success: true, messageId: String(body.result.message_id) };
      }
      // If failed and caption was present, retry with plain unformatted caption
      if (caption) {
        const fallbackForm = new FormData();
        fallbackForm.append('chat_id', String(chatId));
        fallbackForm.append('photo', blob, 'design.png');
        fallbackForm.append('caption', caption.replace(/[*_`\[\]()]/g, ''));
        if (replyMarkup) fallbackForm.append('reply_markup', typeof replyMarkup === 'string' ? replyMarkup : JSON.stringify(replyMarkup));
        const fbRes = await fetch(url, { method: 'POST', body: fallbackForm, signal: AbortSignal.timeout(20000) });
        const fbBody = await fbRes.json().catch(() => null) as any;
        if (fbRes.ok && fbBody?.ok === true && Number.isSafeInteger(fbBody.result?.message_id)) {
          return { success: true, messageId: String(fbBody.result.message_id) };
        }
      }
      return { success: false, error: `TELEGRAM_PHOTO_FAILED_${body?.error_code || res.status}` };
    } catch {
      return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' };
    }
  }

  /**
   * Handles English bot slash commands (/start, /status, /help, /review, /approve, /publish, /revise, /reject)
   */
  handleCommand(text: string, chatId?: string | number, senderId?: string | number): TelegramCommandResult | null {
    const trimmed = text.trim();
    const isPublicCommand = trimmed.startsWith('/start') || trimmed.startsWith('/help');
    if (!isPublicCommand && senderId && this.config.allowedUserIds && this.config.allowedUserIds.length > 0) {
      const sId = String(senderId);
      if (!this.config.allowedUserIds.includes(sId)) {
        return {
          text: `🚫 *Unauthorized*: User \`${sId}\` is not permitted to execute office commands.`,
          parse_mode: 'Markdown',
        };
      }
    }
    if (trimmed.startsWith('/start') || trimmed.startsWith('/help')) {
      return {
        text:
          `👋 *Welcome to Hawa Creative OS Bot*\n\n` +
          `You can send design requests directly to this bot!\n\n` +
          `• Send any design brief or text prompt to create an editable design in Canva.\n` +
          `• Send voice notes in Kurdish or English.\n\n` +
          `_Note: Official publication to Google Drive & Sheets requires Art Director review and approval in Hawa Desk._`,
        parse_mode: 'Markdown',
      };
    }

    if (trimmed.startsWith('/status')) {
      const s = this.getStatus();
      return {
        text:
          `📊 *Hawa Telegram Bridge Status*\n\n` +
          `• *Mode:* \`${s.mode}\`\n` +
          `• *Ingress:* \`${s.ingressUrl}\`\n` +
          `• *Processed Updates:* \`${s.processedCount}\`\n` +
          `• *Uptime:* ${s.uptimeSeconds}s`,
        parse_mode: 'Markdown',
      };
    }

    if (trimmed.startsWith('/approve') || trimmed.startsWith('/publish')) {
      const parts = trimmed.split(' ');
      const taskId = parts[1];
      if (!taskId) {
        return {
          text: `⚠️ *Usage:* \`/approve <taskId>\` or \`/publish <taskId>\``,
          parse_mode: 'Markdown',
        };
      }
      return {
        action: 'approve' as const,
        taskId,
        text: `⏳ *Processing approval & omnichannel publication for task \`${taskId.replace(/`/g, '')}\`...*`,
        parse_mode: 'Markdown',
      };
    }

    if (trimmed.startsWith('/revise') || trimmed.startsWith('/reject')) {
      const parts = trimmed.split(' ');
      const taskId = parts[1];
      if (!taskId) {
        return {
          text: `⚠️ *Usage:* \`/revise <taskId> [feedback notes]\` or \`/reject <taskId> [reason]\``,
          parse_mode: 'Markdown',
        };
      }
      const notes = parts.slice(2).join(' ') || 'Revision requested via Telegram chat';
      return {
        action: 'revision' as const,
        taskId,
        notes,
        text: `✏️ *Revision request logged for task \`${taskId.replace(/`/g, '')}\`:*\n_${escapeTelegramMarkdown(notes)}_`,
        parse_mode: 'Markdown',
      };
    }

    if (trimmed.startsWith('/redo') || trimmed.startsWith('/redrive')) {
      const parts = trimmed.split(' ');
      const taskId = parts[1];
      if (!taskId) {
        return {
          action: 'redrive' as const,
          text: `🔄 *Re-driving design generation for the most recent failed task...*`,
          parse_mode: 'Markdown',
        };
      }
      return {
        action: 'redrive' as const,
        taskId,
        text: `🔄 *Re-driving design generation for task \`${taskId.replace(/`/g, '')}\`...*`,
        parse_mode: 'Markdown',
      };
    }

    if (trimmed.startsWith('/review')) {
      const parts = trimmed.split(' ');
      const taskId = parts[1] || 'sample-task';
      return this.formatTaskPreviewCard({
        id: taskId,
        title: `Task ${taskId}`,
        status: 'AWAITING_APPROVAL',
      });
    }

    return null;
  }

  /**
   * Normalizes a raw Telegram update into a Hawa verified message envelope (FR-002)
   */
  normalizeUpdate(update: TelegramUpdate) {
    if (update.callback_query) {
      const cb = update.callback_query;
      const msg = cb.message;
      const senderName =
        [cb.from?.first_name, (cb.from as any)?.last_name].filter(Boolean).join(' ') ||
        cb.from?.username ||
        'Telegram User';
      const channelId = String(msg?.chat?.id || cb.from?.id || 'tg_default');
      return {
        isCallbackQuery: true,
        callbackQueryId: cb.id,
        callbackData: cb.data || '',
        source: {
          platform: 'telegram' as const,
          channelId,
          messageId: String(msg?.message_id || cb.id),
          senderId: String(cb.from?.id || ''),
          senderName,
          username: cb.from?.username,
          threadId: msg && msg.chat.id !== cb.from?.id ? String(msg.chat.id) : undefined,
        },
        senderName,
        content: {
          text: cb.data || '',
          attachments: [],
        },
        sentAt: new Date().toISOString(),
      };
    }

    if (!update.message) return null;
    const msg = update.message;
    const senderName =
      [msg.from?.first_name, (msg.from as any)?.last_name].filter(Boolean).join(' ') ||
      msg.from?.username ||
      'Telegram User';

    return {
      isCallbackQuery: false,
      source: {
        platform: 'telegram' as const,
        channelId: String(msg.chat.id),
        messageId: String(msg.message_id),
        senderId: String(msg.from?.id || ''),
        senderName,
        username: msg.from?.username,
        threadId: msg.chat.id !== msg.from?.id ? String(msg.chat.id) : undefined,
      },
      senderName,
      content: {
        text: msg.text || (msg.voice ? '[Voice Note]' : ''),
        attachments: msg.voice
          ? [
              {
                id: msg.voice.file_id,
                kind: 'audio' as const,
                filename: `voice_${msg.message_id}.ogg`,
                mimeType: msg.voice.mime_type,
                byteSize: msg.voice.file_size,
              },
            ]
          : [],
      },
      sentAt: new Date(msg.date * 1000).toISOString(),
    };
  }

  /**
   * Simulates or ingests a Telegram update and returns the normalized envelope
   */
  async processUpdate(update: TelegramUpdate): Promise<{ processed: boolean; envelope: any; botResponse?: any }> {
    this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
    if (this.config.offsetStorage) {
      await this.config.offsetStorage.setOffset(this.lastUpdateId).catch(() => {});
    }
    const envelope = this.normalizeUpdate(update);
    if (!envelope) {
      return { processed: false, envelope: null };
    }

    this.processedCount++;

    let botResponse: any = null;
    if (update.callback_query && update.callback_query.data) {
      const cbData = update.callback_query.data;
      const actorId = String(update.callback_query.from?.id || '');

      if (cbData.startsWith('act:')) {
        if (this.config.actionTokenService) {
          const verifyRes = this.config.actionTokenService.verifyAndConsumeToken(cbData, {
            actorId,
            allowedActors: this.config.allowedUserIds,
          });
          if (verifyRes.ok) {
            const p = verifyRes.payload;
            await this.answerCallbackQuery(
              update.callback_query.id,
              p.action === 'approve' ? '✅ Campaign Approved & Publishing!' : '✏️ Revision Requested'
            );
            botResponse = {
              action: p.action,
              taskId: p.taskId,
              revisionId: p.revisionId,
              actorId: p.actorId,
              nonce: p.nonce,
              text: p.action === 'approve'
                ? `✅ Task \`${p.taskId}\` approved via verified action token.`
                : `✏️ Revision requested for task \`${p.taskId}\`.`,
              parse_mode: 'Markdown',
            };
          } else {
            await this.answerCallbackQuery(update.callback_query.id, `❌ ${verifyRes.error}`, true);
            botResponse = {
              error: verifyRes.error,
              errorCode: verifyRes.code,
              text: `⚠️ *Action Denied:* ${verifyRes.error}`,
              parse_mode: 'Markdown',
            };
          }
        }
      } else {
        const parsed = parseCallbackData(cbData);
        if (parsed) {
          if (this.config.allowedUserIds && this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(actorId)) {
            await this.answerCallbackQuery(update.callback_query.id, '❌ Unauthorized user', true);
            botResponse = {
              error: 'Unauthorized user',
              errorCode: 'UNAUTHORIZED_ACTOR',
              text: `⚠️ *Action Denied:* User \`${actorId}\` is not authorized to approve tasks.`,
              parse_mode: 'Markdown',
            };
          } else {
            const hmacKey = this.config.secretToken || process.env.HAWA_ACTION_HMAC_SECRET;
            let isValid = true;
            if (hmacKey) {
              try {
                isValid = verifyActionSignature(parsed.taskId, parsed.action, parsed.signature, hmacKey);
              } catch {
                isValid = false;
              }
            }
            if (!isValid) {
              await this.answerCallbackQuery(update.callback_query.id, '❌ Invalid or forged action signature', true);
              botResponse = {
                error: 'Invalid or forged action signature',
                errorCode: 'INVALID_SIGNATURE',
                text: `⚠️ *Action Denied:* Invalid or forged action signature.`,
                parse_mode: 'Markdown',
              };
            } else {
              await this.answerCallbackQuery(
                update.callback_query.id,
                parsed.action === 'approve' ? '✅ Campaign Approved & Publishing!' : '✏️ Revision Requested'
              );
              botResponse = {
                action: parsed.action,
                taskId: parsed.taskId,
                signature: parsed.signature,
                text: parsed.action === 'approve'
                  ? `✅ Task \`${parsed.taskId}\` approved via button click.`
                  : `✏️ Revision requested for task \`${parsed.taskId}\`.`,
                parse_mode: 'Markdown',
              };
            }
          }
        }
      }
    } else if (update.message?.text?.startsWith('/')) {
      botResponse = this.handleCommand(update.message.text, update.message.chat.id, update.message.from?.id);
      if (botResponse && botResponse.text) {
        await this.dispatchOutboundMessage(update.message.chat.id, botResponse);
      }
    }

    return { processed: true, envelope, botResponse };
  }
}

export const TelegramBridge = TelegramBridgeDaemon;
export type TelegramBridge = TelegramBridgeDaemon;

