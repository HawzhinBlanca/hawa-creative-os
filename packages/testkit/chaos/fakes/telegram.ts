/**
 * A fake Telegram Bot API for the chaos suite: the methods Core's bridge and the worker's sender call
 * (packages/integrations/src/telegram-bridge.ts), a scripted update queue, and a log of everything the
 * bot sent, so the driver can check that each message arrived once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dropConnection, parseJson, readBody, sendJson, sha256, sleep } from './http-util.ts';

export type TelegramFaultKind = '429' | '5xx' | 'drop-after-processing' | 'delay';

export interface TelegramFault {
  method: string;
  /** Only sends to this chat; any chat when absent. */
  chat?: string;
  kind: TelegramFaultKind;
  /** How many calls the fault applies to. */
  n: number;
  retryAfter?: number;
  delayMs?: number;
  /** Matching calls to let through first (the draft is a chat's second message, after the acknowledgement). */
  skip?: number;
}

export interface SentRecord {
  seq: number;
  method: string;
  chat_id: string;
  /** SHA-256 of the text or caption, so two sends of one message compare equal. */
  textHash: string | null;
  /** The first 300 characters, for the report; chaos fixtures carry no personal data. */
  text: string | null;
  documentSha256: string | null;
  fileName: string | null;
  replyMarkup: unknown;
  at: string;
  /** Set when a fault answered this call; the message still counts as sent for drop-after-processing. */
  fault: TelegramFaultKind | null;
  /** Whether Telegram would have shown it to the chat. */
  delivered: boolean;
}

export interface FakeFile {
  file_id: string;
  size: number;
  mime: string;
  /** Wait before the download answers, as a large file on a slow line would. */
  delayMs: number;
}

export interface PollRecord {
  at: string;
  offset: number;
  returned: number[];
}

const SEND_METHODS = new Set(['sendMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup', 'editMessageText', 'editMessageReplyMarkup', 'copyMessage', 'forwardMessage']);

/** Bytes that read as the start of a JPEG, then zeros: enough for Core's type sniffing. */
function fakeFileBytes(file: FakeFile): Buffer {
  const bytes = Buffer.alloc(Math.max(16, file.size));
  if (file.mime === 'application/pdf') bytes.write('%PDF-1.4\n', 0, 'latin1');
  else if (file.mime === 'image/png') Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  else Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]).copy(bytes);
  if (file.mime === 'image/jpeg') bytes.writeUInt16BE(0xffd9, bytes.length - 2);
  return bytes;
}

export class FakeTelegram {
  private updates: any[] = [];
  // Telegram's ids only grow, and the bot keeps its offset across restarts of the fakes: counting
  // from the clock (in ms) keeps a restarted fake above every id it handed out before.
  private nextUpdateId = Date.now() - 1_700_000_000_000;
  private messageSeq = 5000;
  private seq = 0;
  private faults: TelegramFault[] = [];
  private files = new Map<string, FakeFile>();
  readonly sent: SentRecord[] = [];
  readonly polls: PollRecord[] = [];
  readonly calls: Array<{ method: string; at: string }> = [];

  reset(): void {
    this.updates = [];
    this.faults = [];
    this.files.clear();
    this.sent.length = 0;
    this.polls.length = 0;
    this.calls.length = 0;
  }

  /** Queues updates for getUpdates; each gets the next update_id unless it names one. */
  enqueue(updates: any[]): number[] {
    const ids: number[] = [];
    for (const u of updates) {
      const update = { ...u, update_id: Number.isInteger(u.update_id) ? u.update_id : this.nextUpdateId++ };
      this.nextUpdateId = Math.max(this.nextUpdateId, update.update_id + 1);
      this.updates.push(update);
      ids.push(update.update_id);
    }
    return ids;
  }

  clearFaults(): void {
    this.faults = [];
  }

  addFault(fault: TelegramFault): void {
    this.faults.push({ ...fault, n: fault.n ?? 1 });
  }

  addFile(file: Partial<FakeFile> & { file_id: string }): void {
    this.files.set(file.file_id, { size: 1024, mime: 'image/jpeg', delayMs: 0, ...file });
  }

  /** Updates Telegram still holds: those at or above the last offset the bot confirmed. */
  pending(): any[] {
    return [...this.updates];
  }

  private takeFault(method: string, chat: string | null): TelegramFault | null {
    const fault = this.faults.find((f) => f.n > 0 && f.method === method && (!f.chat || f.chat === chat));
    if (!fault) return null;
    if ((fault.skip ?? 0) > 0) {
      fault.skip = (fault.skip ?? 0) - 1;
      return null;
    }
    fault.n--;
    return fault;
  }

  private async params(req: IncomingMessage, query: URLSearchParams): Promise<{ fields: Record<string, string>; file: { bytes: Buffer; name: string } | null }> {
    const fields: Record<string, string> = {};
    for (const [k, v] of query) fields[k] = v;
    if (req.method !== 'POST') return { fields, file: null };
    const body = await readBody(req);
    const type = String(req.headers['content-type'] || '');
    if (type.startsWith('multipart/form-data')) {
      // undici parses multipart for us: the same parser the bridge's FormData came from.
      const form = await new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData();
      let file: { bytes: Buffer; name: string } | null = null;
      for (const [k, v] of form) {
        if (typeof v === 'string') fields[k] = v;
        else file = { bytes: Buffer.from(await v.arrayBuffer()), name: v.name };
      }
      return { fields, file };
    }
    const json = parseJson(body);
    for (const [k, v] of Object.entries(json)) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
    return { fields, file: null };
  }

  private async getUpdates(res: ServerResponse, fields: Record<string, string>): Promise<void> {
    const offset = Number(fields.offset || 0);
    // Telegram forgets every update below the offset the bot sends: it has confirmed them.
    if (offset > 0) this.updates = this.updates.filter((u) => u.update_id >= offset);
    // A long poll that finds nothing waits a little, so an idle bot does not spin.
    if (!this.updates.length) await sleep(Math.min(1000, Number(fields.timeout || 0) * 1000));
    const result = this.updates.filter((u) => u.update_id >= offset).slice(0, Number(fields.limit || 100));
    this.polls.push({ at: new Date().toISOString(), offset, returned: result.map((u) => u.update_id) });
    sendJson(res, 200, { ok: true, result });
  }

  private record(method: string, fields: Record<string, string>, file: { bytes: Buffer; name: string } | null, fault: TelegramFaultKind | null, delivered: boolean): SentRecord {
    const text = fields.text ?? fields.caption ?? null;
    let replyMarkup: unknown = null;
    try { replyMarkup = fields.reply_markup ? JSON.parse(fields.reply_markup) : null; } catch { replyMarkup = fields.reply_markup; }
    const record: SentRecord = {
      seq: ++this.seq,
      method,
      chat_id: String(fields.chat_id ?? ''),
      textHash: text === null ? null : sha256(text),
      text: text === null ? null : text.slice(0, 300),
      documentSha256: file ? sha256(file.bytes) : null,
      fileName: file?.name ?? null,
      replyMarkup,
      at: new Date().toISOString(),
      fault,
      delivered,
    };
    this.sent.push(record);
    return record;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const file = /^\/file\/bot[^/]+\/(.+)$/.exec(path);
    if (file) return this.download(res, file[1]);
    const m = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(path);
    if (!m) return sendJson(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const method = m[1];
    this.calls.push({ method, at: new Date().toISOString() });
    const { fields, file: upload } = await this.params(req, query);
    const chat = fields.chat_id !== undefined ? String(fields.chat_id) : null;
    const fault = this.takeFault(method, chat);

    if (fault?.kind === 'delay') await sleep(fault.delayMs ?? 1000);
    if (fault?.kind === '429') {
      const retryAfter = fault.retryAfter ?? 3;
      if (SEND_METHODS.has(method)) this.record(method, fields, upload, '429', false);
      return sendJson(res, 429, { ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`, parameters: { retry_after: retryAfter } });
    }
    if (fault?.kind === '5xx') {
      if (SEND_METHODS.has(method)) this.record(method, fields, upload, '5xx', false);
      return sendJson(res, 502, { ok: false, error_code: 502, description: 'Bad Gateway' });
    }

    switch (method) {
      case 'getUpdates':
        return this.getUpdates(res, fields);
      case 'getMe':
        return sendJson(res, 200, { ok: true, result: { id: 7000001, is_bot: true, first_name: 'Hawa chaos bot', username: 'hawa_chaos_bot' } });
      case 'getFile': {
        const f = this.files.get(String(fields.file_id));
        if (!f) return sendJson(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
        return sendJson(res, 200, { ok: true, result: { file_id: f.file_id, file_unique_id: `u-${f.file_id}`, file_size: f.size, file_path: `documents/${f.file_id}` } });
      }
      case 'answerCallbackQuery':
      case 'setMyCommands':
      case 'deleteWebhook':
      case 'setWebhook':
        return sendJson(res, 200, { ok: true, result: true });
      case 'getWebhookInfo':
        return sendJson(res, 200, { ok: true, result: { url: '', pending_update_count: this.updates.length } });
    }

    if (!SEND_METHODS.has(method)) return sendJson(res, 400, { ok: false, error_code: 400, description: `Bad Request: method ${method} is not faked` });
    this.record(method, fields, upload, fault?.kind === 'drop-after-processing' ? 'drop-after-processing' : null, true);
    // The message reached the chat, and the answer is lost: the sender cannot know it arrived.
    if (fault?.kind === 'drop-after-processing') return dropConnection(res);
    const chatId = /^-?\d+$/.test(chat || '') ? Number(chat) : chat;
    sendJson(res, 200, {
      ok: true,
      result: { message_id: ++this.messageSeq, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: fields.text },
    });
  }

  private async download(res: ServerResponse, filePath: string): Promise<void> {
    const id = filePath.replace(/^documents\//, '');
    const f = this.files.get(id);
    if (!f) return sendJson(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    if (f.delayMs > 0) await sleep(f.delayMs);
    const bytes = fakeFileBytes(f);
    res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': String(bytes.length) });
    res.end(bytes);
  }
}
