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
  async processUpdate(update: TelegramUpdate): Promise<{ processed: boolean; envelope: any }> {
    this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
    const envelope = this.normalizeUpdate(update);
    if (!envelope) {
      return { processed: false, envelope: null };
    }

    this.processedCount++;
    return { processed: true, envelope };
  }
}
