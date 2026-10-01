/**
 * The script language of the natural-language stress suite (ADR-182): what a requester, a colleague
 * and the office do, step by step, and what a thoughtful office assistant would have done.
 *
 * A script plays with `Play` (below) and then checks its outcome. Every script is also held to the
 * rules every requester-facing message must follow (`frictionIssues`): no command, no id or internal
 * word, no demand to reply to a particular message or to use a format, and an answer to every message
 * a person sends in a private chat, never two answers saying the same thing.
 */
import { randomUUID } from 'node:crypto';
import { ConversationHarness, type Inbound, type Person, type Sent } from './conversation-harness.js';

export interface Script {
  /** S001 … */
  id: string;
  /** What happens, in English. */
  title: string;
  /** The kinds of friction the script covers (for the report). */
  kinds: string[];
  /** What a thoughtful human office assistant would do. */
  natural: string;
  play(p: Play): Promise<void>;
  /**
   * A defect still open (ADR-182 "what is left"): the script asserts the natural outcome, and the test
   * is expected to fail until it is fixed.
   */
  open?: string;
}

const personId = () => 71_000_000 + Math.floor(Math.random() * 20_000_000);

/** One conversation: the requester, their colleague, the office, and the harness under them. */
export class Play {
  readonly me: Person = { id: personId(), name: 'Sewa' };
  readonly colleague: Person = { id: personId(), name: 'Dara' };
  readonly office: Person[];
  readonly chatId: string;
  /** Updates a person sent that need no answer of their own (a split part, group chatter, a burst photo). */
  readonly quiet = new Set<number>();

  constructor(readonly h: ConversationHarness, office: Person[], type: 'private' | 'group' = 'private', chatId?: string) {
    this.office = office;
    // A private chat's id is its person's id, as in Telegram (ADR-200 reads the requester's name by it).
    this.chatId = h.chat(type, chatId ? Number(chatId) : type === 'private' ? this.me.id : undefined);
  }

  /** The requester (or `from`) writes words, `after` ms after the previous step. */
  say(text: string, o: { from?: Person; after?: number; replyTo?: number; entities?: unknown[]; quiet?: boolean } = {}): Promise<Inbound> {
    return this.track(this.h.post(this.chatId, o.from ?? this.me, 'text', { text,
      ...(o.replyTo ? { reply_to_message: this.replyTarget(o.replyTo) } : {}),
      ...(o.entities ? { entities: o.entities } : {}) }, o.after ?? 20_000, text.slice(0, 60)), o.quiet);
  }

  /** A forwarded message: someone else's words, sent on by the requester. */
  forward(text: string, o: { from?: Person; originalSender?: string; after?: number; quiet?: boolean } = {}): Promise<Inbound> {
    return this.track(this.h.post(this.chatId, o.from ?? this.me, 'forward', { text,
      forward_origin: { type: 'hidden_user', sender_user_name: o.originalSender ?? 'Colleague', date: 1_789_990_000 },
      forward_sender_name: o.originalSender ?? 'Colleague', forward_date: 1_789_990_000 }, o.after ?? 20_000, `forward: ${text.slice(0, 40)}`), o.quiet);
  }

  /** A photo (outside an album unless `album` names one), with or without a caption. */
  photo(n: number, o: { caption?: string; album?: string; from?: Person; after?: number; replyTo?: number; quiet?: boolean } = {}): Promise<Inbound> {
    const file = this.h.photoFile(n);
    return this.track(this.h.post(this.chatId, o.from ?? this.me, 'photo', {
      photo: [{ file_id: `${file}-small`, file_unique_id: `u-${file}-s`, width: 90, height: 90, file_size: 900 },
        { file_id: file, file_unique_id: `u-${file}`, width: 1280, height: 960, file_size: 90_000 }],
      ...(o.caption ? { caption: o.caption } : {}), ...(o.album ? { media_group_id: o.album } : {}),
      ...(o.replyTo ? { reply_to_message: this.replyTarget(o.replyTo) } : {}) }, o.after ?? 20_000,
      `photo ${n}${o.caption ? `: ${o.caption.slice(0, 40)}` : ''}`), o.quiet);
  }

  /** An album of photos: Telegram sends each as its own update, a moment apart; the caption rides on the first. */
  async album(ns: number[], o: { caption?: string; after?: number; from?: Person; quiet?: boolean } = {}): Promise<Inbound[]> {
    const group = `album-${randomUUID().slice(0, 8)}`;
    const parts: Inbound[] = [];
    for (const [i, n] of ns.entries()) {
      parts.push(await this.photo(n, { album: group, from: o.from, after: i === 0 ? o.after ?? 20_000 : 300,
        quiet: o.quiet || i < ns.length - 1, ...(i === 0 && o.caption ? { caption: o.caption } : {}) }));
    }
    return parts;
  }

  /** A voice note whose words (as transcribed) are `words`. */
  async voice(words: string, o: { after?: number; caption?: string; from?: Person } = {}): Promise<Inbound> {
    const voice = await this.h.voiceFile(words);
    return this.track(this.h.post(this.chatId, o.from ?? this.me, 'voice', { voice: voice, ...(o.caption ? { caption: o.caption } : {}) },
      o.after ?? 20_000, `voice: ${words.slice(0, 40)}`));
  }

  /** A PDF whose text is `words`. */
  async pdf(words: string, o: { after?: number; caption?: string; from?: Person } = {}): Promise<Inbound> {
    const document = await this.h.pdfFile(words);
    return this.track(this.h.post(this.chatId, o.from ?? this.me, 'pdf', { document, ...(o.caption ? { caption: o.caption } : {}) },
      o.after ?? 20_000, `pdf: ${words.slice(0, 40)}`));
  }

  sticker(emoji: string, o: { after?: number; replyTo?: number; quiet?: boolean } = {}): Promise<Inbound> {
    return this.track(this.h.post(this.chatId, this.me, 'sticker', { sticker: { file_id: `sticker-${emoji}`, file_unique_id: `s-${emoji}`,
      type: 'regular', width: 512, height: 512, is_animated: false, is_video: false, emoji },
      ...(o.replyTo ? { reply_to_message: this.replyTarget(o.replyTo) } : {}) }, o.after ?? 20_000, `sticker ${emoji}`), o.quiet);
  }

  edit(of: Inbound, text: string, o: { after?: number; quiet?: boolean } = {}): Promise<Inbound> {
    return this.track(this.h.edit(of, text, o.after ?? 20_000), o.quiet);
  }

  wait(ms: number): Promise<void> { return this.h.wait(ms); }

  private replyTarget(messageId: number): Record<string, unknown> {
    const bot = this.h.t.sent.some((s) => s.chatId === this.chatId && s.messageId === messageId);
    const own = this.h.t.inbound.find((i) => i.chatId === this.chatId && i.messageId === messageId);
    return { message_id: messageId, date: 1_790_000_000, chat: { id: Number(this.chatId), type: 'private' },
      from: bot ? { id: 7_000_001, is_bot: true, first_name: 'Hawa' } : { id: own?.from.id ?? this.me.id, is_bot: false, first_name: own?.from.name ?? 'Sewa' },
      ...(own?.text ? { text: own.text } : {}) };
  }

  private async track(p: Promise<Inbound>, quiet?: boolean): Promise<Inbound> {
    const inbound = await p;
    if (quiet) this.quiet.add(inbound.updateId);
    return inbound;
  }

  // --- the office ---------------------------------------------------------------------------

  /** The i-th request this chat opened. */
  request(i = 0): string {
    const opened = this.h.t.opened.filter((o) => o.chatId === this.chatId);
    if (!opened[i]) throw new Error(`the chat opened ${opened.length} requests, not ${i + 1}`);
    return opened[i].requestId;
  }

  async draftReady(i = 0, after = 3 * 60_000): Promise<void> {
    await this.h.wait(after);
    await this.h.draftReady(this.request(i), 0);
  }

  /** An office member replies to the draft's alert in their private chat. */
  async officeReplies(text: string, i = 0, member = this.office[0], after = 60_000): Promise<Inbound> {
    await this.h.wait(after);
    const alert = this.h.alertFor(member, this.request(i));
    if (!alert) throw new Error('the office member was not sent the draft');
    return this.h.officeSays(member, text, { replyTo: alert, after: 0 });
  }

  async delivered(i = 0, after = 60_000): Promise<void> {
    await this.h.wait(after);
    await this.h.delivered(this.request(i), 0);
  }

  // --- what happened ------------------------------------------------------------------------

  /** Everything the bot said in this chat. */
  get said(): Sent[] { return this.h.said(this.chatId); }
  /** The words of everything the bot said in this chat, joined. */
  get words(): string { return this.said.map((s) => s.text).join('\n---\n'); }
  /** What the bot said in this chat while one step was the latest (its answer, settles, the open's). */
  answer(to: Inbound): string { return this.h.saidFor(to).map((s) => s.text).join('\n---\n'); }
  /** The requests this chat opened (as ChatInbox opened them). */
  get opened() { return this.h.t.opened.filter((o) => o.chatId === this.chatId); }
  /** Requester changes started as design rounds. */
  get revisions() { return this.h.t.revisions.filter((r) => this.opened.some((o) => o.requestId === r.requestId)); }
  /** Words kept on a request for the office. */
  get kept() { return this.h.t.kept.filter((k) => this.opened.some((o) => o.requestId === k.requestId)); }
  /** Messages to office members about this chat. */
  get officeHeard(): Sent[] {
    const members = this.office.map((m) => String(m.id));
    return this.h.t.sent.filter((s) => members.includes(s.chatId) && (s.text.includes(this.chatId) ||
      this.opened.some((o) => s.key.startsWith(o.requestId))));
  }
  /** The brief of the i-th request, as opened. */
  brief(i = 0): string { return String(this.opened[i]?.draft.rawText ?? ''); }
  lastBotMessage(): number {
    const last = this.h.lastBot(this.chatId);
    if (!last) throw new Error('the bot has said nothing here');
    return last.messageId;
  }
  botMessage(key: RegExp): number {
    const found = this.h.lastBot(this.chatId, key);
    if (!found) throw new Error(`no bot message with key ${key}`);
    return found.messageId;
  }
  stages = async () => (await this.h.requests(this.chatId)).map((r) => r.stage);
}

// -------------------------------------------------------------------------------------------------
// What every requester-facing message must never do
// -------------------------------------------------------------------------------------------------

const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const JARGON = /\bDirective \(|\b(?:lifecycle|intake|payload|workflow|restate|webhook|update[_ ]id|request[_ ]id|task[_ ]id|stage|rev(?:ision)?\s*\d|LATE_[A-Z_]+|[A-Z]{3,}_[A-Z_]{3,}|in_review|awaiting_answer|human_review|null|undefined|NaN|\[object)/;
const COMMAND = /(?:^|\s)\/[a-z_]{2,}\b/i;
const REPLY_DEMAND = /\b(?:reply|respond)\s+(?:directly\s+)?(?:to|on)\s+(?:the|this|that|my|its)\b|\bswipe\b|\breply to (?:it|this)\b/i;
const FORMAT_DEMAND = /\bClient:\s*<|\bformat\b|\bexactly this\b|\bstart (?:the|your) (?:message|caption) with\b/i;

/** Why a requester-facing message breaks the natural-language rule, or nothing. */
export function frictionIssues(text: string): string[] {
  const issues: string[] = [];
  const plain = text.replace(/<\/?b>/g, '');
  if (COMMAND.test(plain)) issues.push('names a command');
  if (UUIDISH.test(plain)) issues.push('shows an id');
  const jargon = JARGON.exec(plain);
  if (jargon) issues.push(`internal word "${jargon[0]}"`);
  if (REPLY_DEMAND.test(plain)) issues.push('asks for a reply to a particular message');
  if (FORMAT_DEMAND.test(plain)) issues.push('asks for a format');
  if (/Hawa Desk|\bDesk\b/.test(plain)) issues.push('names the office tool');
  return issues;
}
