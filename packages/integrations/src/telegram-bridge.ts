import { computeActionSignature, verifyActionSignature } from './outbound-notifier.js';

export interface TelegramBridgeConfig {
  botToken?: string;
  secretToken?: string;
  targetIngressUrl?: string;
  pollIntervalMs?: number;
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
  action?: 'approve' | 'revision';
  taskId?: string;
  notes?: string;
}

export function parseCallbackData(data: string): { action: 'approve' | 'revision'; taskId: string; signature: string } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length < 3) return null;
  const [action, taskId, signature] = parts;
  if (action !== 'approve' && action !== 'revision') return null;
  return { action, taskId, signature };
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
   * Polls Telegram getUpdates endpoint once with offset tracking and abort control
   */
  async pollOnce(onUpdate?: (update: TelegramUpdate) => Promise<void>): Promise<number> {
    if (!this.config.botToken) return 0;
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5`;
      const res = await fetch(url, { signal: this.abortController?.signal });
      if (!res.ok) return 0;
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        let count = 0;
        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          if (onUpdate) {
            await onUpdate(update);
          } else {
            await this.processUpdate(update);
          }
          count++;
        }
        return count;
      }
    } catch {
      // AbortError or transient network failure
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
        await new Promise((r) => setTimeout(r, 800));
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
    return {
      active: this.active || this.webhookActive,
      mode: this.webhookActive ? 'webhook_push' : (this.config.botToken ? 'live_polling' : 'offline_daemon'),
      lastUpdateId: this.lastUpdateId,
      processedCount: this.processedCount,
      ingressUrl: this.webhookUrl || this.config.targetIngressUrl || 'http://127.0.0.1:8080/api/webhooks/telegram',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      webhookActive: this.webhookActive,
      webhookUrl: this.webhookUrl,
    };
  }

  getSentMessages() {
    return [...this.sentMessages];
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
    },
    secretKey = 'hawa_safe_secret_key'
  ) {
    const baseUrl = task.deskBaseUrl || process.env.HAWA_DESK_BASE_URL || 'http://localhost:4173';
    const docParam = task.docId || task.id;
    const studioUrl = `${baseUrl}/review?doc=${docParam}&taskId=${task.id}&mode=review`;

    const approveSig = computeActionSignature(task.id, 'approve', secretKey);
    const revisionSig = computeActionSignature(task.id, 'revision', secretKey);

    const text = [
      `⚡ *Task Ready for Operator Review*`,
      ``,
      `🎯 *Title:* ${task.title}`,
      `🏢 *Client:* ${task.clientName || 'Hawa Creative Office'}`,
      `📊 *Status:* \`${task.status}\``,
      task.voiceTranscript ? `🎙️ *Spoken Voice Memo:* _"${task.voiceTranscript}"_` : null,
      task.copy ? `📝 *Approved Copy:* _${task.copy}_` : null,
      ``,
      `🔍 *Desk Studio Link:*`,
      `${studioUrl}`,
    ]
      .filter(Boolean)
      .join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve & Publish', callback_data: `approve:${task.id}:${approveSig}` },
          { text: '✏️ Request Revision', callback_data: `revision:${task.id}:${revisionSig}` },
        ],
        [
          { text: '⚡ Open Desk Studio', url: studioUrl },
          { text: '📋 View Evidence', url: `${baseUrl}/` },
        ],
      ],
    };

    return { text, parse_mode: 'Markdown', reply_markup: replyMarkup };
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
    const text = [
      `✅ *Deliverables Approved & Published*`,
      ``,
      `🎯 *Task:* ${task.title}`,
      `📁 *Google Drive Folder:* ${task.driveUrl}`,
      task.sheetUrl ? `📊 *Google Sheets Audit Row:* ${task.sheetUrl}` : null,
      task.workflowId ? `🆔 *Restate Workflow ID:* \`${task.workflowId}\`` : null,
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
  ): Promise<{ success: boolean; messageId?: string }> {
    const record = {
      chatId,
      text: message.text,
      replyMarkup: message.reply_markup,
      sentAt: new Date().toISOString(),
    };
    this.sentMessages.push(record);

    if (this.config.botToken) {
      try {
        const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message.text,
            parse_mode: message.parse_mode || 'Markdown',
            reply_markup: message.reply_markup,
          }),
        }).catch(() => {});
      } catch {
        // Log & proceed in disconnected test environments
      }
    }

    return { success: true, messageId: `msg_${Date.now()}` };
  }

  /**
   * Handles English bot slash commands (/start, /status, /help, /review, /approve, /publish, /revise, /reject)
   */
  handleCommand(text: string, chatId?: string | number): TelegramCommandResult | null {
    const trimmed = text.trim();
    if (trimmed.startsWith('/start') || trimmed.startsWith('/help')) {
      return {
        text:
          `👋 *Welcome to Hawa Creative OS Bot*\n\n` +
          `Available commands:\n` +
          `• \`/status\` - Inspect engine, bridge & ingress status\n` +
          `• \`/review <id>\` - Generate interactive Studio review card\n` +
          `• \`/approve <id>\` - Approve task and publish to Google Drive & Sheets\n` +
          `• \`/publish <id>\` - Trigger omnichannel publishing\n` +
          `• \`/revise <id> [notes]\` - Request design revision\n` +
          `• Send any text or voice note to capture an ad task into Hawa Desk.`,
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
        text: `⏳ *Processing approval & omnichannel publication for task \`${taskId}\`...*`,
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
        text: `✏️ *Revision request logged for task \`${taskId}\`:*\n_${notes}_`,
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
    const envelope = this.normalizeUpdate(update);
    if (!envelope) {
      return { processed: false, envelope: null };
    }

    this.processedCount++;

    let botResponse: any = null;
    if (update.callback_query && update.callback_query.data) {
      const parsed = parseCallbackData(update.callback_query.data);
      if (parsed) {
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
    } else if (update.message?.text?.startsWith('/')) {
      botResponse = this.handleCommand(update.message.text, update.message.chat.id);
      if (botResponse && botResponse.text) {
        await this.dispatchOutboundMessage(update.message.chat.id, botResponse);
      }
    }

    return { processed: true, envelope, botResponse };
  }
}

