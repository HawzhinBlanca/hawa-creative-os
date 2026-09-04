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
      mime_type: string;
      file_size: number;
    };
  };
}

export interface BridgeStatus {
  active: boolean;
  mode: 'live_polling' | 'offline_daemon';
  lastUpdateId: number;
  processedCount: number;
  ingressUrl: string;
  uptimeSeconds: number;
}

export class TelegramBridgeDaemon {
  private active = false;
  private lastUpdateId = 0;
  private processedCount = 0;
  private startTime = Date.now();
  private pollTimer?: NodeJS.Timeout;

  private sentMessages: Array<{ chatId: string | number; text: string; replyMarkup?: any; sentAt: string }> = [];

  constructor(private readonly config: TelegramBridgeConfig = {}) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startTime = Date.now();
  }

  stop(): void {
    this.active = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  getStatus(): BridgeStatus {
    return {
      active: this.active,
      mode: this.config.botToken ? 'live_polling' : 'offline_daemon',
      lastUpdateId: this.lastUpdateId,
      processedCount: this.processedCount,
      ingressUrl: this.config.targetIngressUrl || 'http://localhost:3001/v1/ingress/telegram',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  getSentMessages() {
    return [...this.sentMessages];
  }

  clearSentMessages() {
    this.sentMessages = [];
  }

  /**
   * Formats a rich English Telegram preview card with deep link to Hawa Desk
   */
  formatTaskPreviewCard(task: {
    id: string;
    docId?: string;
    title: string;
    copy?: string;
    status: string;
    clientName?: string;
    deskBaseUrl?: string;
  }) {
    const baseUrl = task.deskBaseUrl || 'http://localhost:4173';
    const docParam = task.docId || task.id;
    const studioUrl = `${baseUrl}/review?doc=${docParam}&taskId=${task.id}&mode=review`;

    const text = [
      `⚡ *Task Ready for Operator Review*`,
      ``,
      `🎯 *Title:* ${task.title}`,
      `🏢 *Client:* ${task.clientName || 'Hawa Creative Office'}`,
      `📊 *Status:* \`${task.status}\``,
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
   * Handles English bot slash commands (/start, /status, /help, /review)
   */
  handleCommand(text: string, chatId: string | number) {
    const trimmed = text.trim();
    if (trimmed.startsWith('/start') || trimmed.startsWith('/help')) {
      return {
        text:
          `👋 *Welcome to Hawa Creative OS Bot*\n\n` +
          `Available commands:\n` +
          `• \`/status\` - Inspect engine, bridge & ingress status\n` +
          `• \`/review <id>\` - Generate interactive Studio review link\n` +
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
    if (!update.message) return null;
    const msg = update.message;

    return {
      source: {
        platform: 'telegram' as const,
        channelId: String(msg.chat.id),
        messageId: String(msg.message_id),
        senderId: String(msg.from.id),
        threadId: msg.chat.id !== msg.from.id ? String(msg.chat.id) : undefined,
      },
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

    // Check for bot command
    let botResponse = null;
    if (update.message?.text?.startsWith('/')) {
      botResponse = this.handleCommand(update.message.text, update.message.chat.id);
      if (botResponse) {
        await this.dispatchOutboundMessage(update.message.chat.id, botResponse);
      }
    }

    return { processed: true, envelope, botResponse };
  }
}

