/**
 * A conversation harness for the requester Telegram path (ADR-182).
 *
 * It plays a scripted conversation the way the production worker carries it: every Telegram update
 * goes through the worker's own ChatInbox (`handleUpdate`, and `settleUpdate` for the settles Core
 * asks for), whose Core client (`createCoreClient`) calls this process's real Core app
 * (`/v1/internal/telegram/intake`) with the worker credential. What ChatInbox sends goes through the
 * worker's own TelegramSender (`handleSend`), which writes the real send marks in Postgres, so a reply
 * to a bot message binds exactly as it does in production; the fake Telegram only numbers messages.
 * A request ChatInbox opens is opened by the worker's own RequestLifecycle (`openAutomaticRequest`,
 * `openManualRequest`), and a requester's change is started by its `recordRequesterDecision`.
 *
 * The office acts through the same code: a draft is finished by `recordDesignFinished` (a Canva
 * binding and its export bytes stand in for the design run, which is never started), and an office
 * member decides in their private Telegram chat, which reaches RequestLifecycle through the signed
 * OfficeDecisionGateway (checked here as the worker checks it). Delivery's end is recorded in Core's
 * rows directly, with the delivery notice sent under the key the Delivery workflow uses.
 *
 * Time is virtual. A step says how long after the previous one it was sent; moving the clock moves
 * every row the conversation wrote back in time (Postgres decides every settle and window from its own
 * `now()`), and runs the settles that fall due, in order, as Restate's delayed calls would.
 *
 * No model is called: the intent router is off (the rules only), a voice note's transcription is the
 * script's own words behind a fake provider, and a PDF's reading is the script's words behind a fake
 * Docling. Any other call to a model provider is recorded as a paid call and fails the script.
 * ADR-200: the office reading of an office member's words is a fixture the script sets
 * (`officeReads`); words it has no reading for get none, as when the model is off.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';
import { canaryChatIdFromEnv, type OutboundMessage, type SendResult } from '@hawa/contracts';
import { CanvaBindingRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { DoclingParser, PDF_EXTRACTOR_VERSION } from '@hawa/retrieval';
import { createApp } from '../../src/app.js';
import { assertNativeRevisionAdmission } from '../../src/services/native-revision-handoff.js';
import type { OfficeIntentModel, OfficeModelDecision, OfficeModelInput } from '../../src/services/office-intent-model.js';
import { handleUpdate, settleUpdate, type ChatInboxView, type InboxContext, type SettleInput } from '../../../worker/src/lifecycle/chat-inbox.js';
import { createCoreClient } from '../../../worker/src/lifecycle/core-client.js';
import { handleSend, type TelegramSenderDeps } from '../../../worker/src/lifecycle/telegram-sender.js';
import { readStoredExportBytes } from '../../../worker/src/delivery-notification.js';
import { checkSignedOfficeDecision, checkSignedOfficeRetry, type SignedOfficeDecision } from '../../../worker/src/lifecycle/office-decision-gateway.js';
import {
  openAutomaticRequest, openManualRequest, recordDesignFinished, recordOfficeDeliveryStart, recordOfficeRetry, recordOfficeRevision,
  recordRequesterDecision, recordWithdraw, type AutomaticOpenContext, type OfficeRetryEvent, type LifecycleState, type OfficeDeliveryStartEvent,
  type OfficeRevisionEvent, type OpenAutomaticEvent, type OpenManualEvent, type RequesterDecisionEvent,
} from '../../../worker/src/lifecycle/request-lifecycle.js';

export const TENANT = '00000000-0000-4000-a000-000000000001';
export const KAAE = 'c1000000-0000-4000-8000-000000000002';
const SCOPE = { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const CORE = 'http://core:3001';
const RESTATE = 'http://restate.conversation:8080';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** A 1×1 PNG made distinct per file, so every photo is its own picture. */
const png = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'), Buffer.from(String(n))]);

export interface Person { id: number; name: string }

/** A message the bot sent (through TelegramSender), with what caused it. */
export interface Sent {
  seq: number; at: number; chatId: string; messageId: number; key: string; text: string;
  kind: 'text' | 'photo' | 'document';
  /** The update whose handling sent it (null: an office step, a settle, a lifecycle event). */
  cause: number | null;
  /** The step of the script that was running when it was sent. */
  step: number;
}

/** An update a person sent, as the harness gave it to ChatInbox. */
export interface Inbound {
  step: number; at: number; updateId: number; chatId: string; messageId: number; from: Person;
  kind: string; text: string; update: Record<string, any>;
}

export interface Opened { requestId: string; chatId: string; draft: Record<string, any>; step: number; auto: boolean }

export interface Transcript {
  inbound: Inbound[];
  sent: Sent[];
  opened: Opened[];
  revisions: Array<{ requestId: string; directive: string; step: number }>;
  /** Words kept on a request for the office (Core's late-change answers). */
  kept: Array<{ requestId: string; step: number; stage: string }>;
  /**
   * Design runs RequestLifecycle started. ADR-233: each passes Core's real admission guard
   * (`assertNativeRevisionAdmission`) as the DesignRun's first Studio call would; `refused` is its code.
   */
  designs: Array<{ requestId: string; taskId: string; runId: string; round: number; refused?: string }>;
  deliveries: string[];
  /** Core's intake answers, per update (the last one for an update that was settled). */
  answers: Map<number, Record<string, any>>;
  /** Calls to a model provider that are not the fake transcription: each one fails the script. */
  paidCalls: string[];
  /** Steps a person sent, in order: the step index is the index here. */
  steps: string[];
}

interface Pending { due: number; seq: number; chatId: string; input: SettleInput; key: string }

export interface HarnessOptions {
  db: Kysely<Database>;
  owner: Kysely<Database>;
  /** The office members (TELEGRAM_ALLOWED_USERS), in order. */
  office: Person[];
  workerToken: string;
  /** Observe actual admission when RequestLifecycle dispatches, before the next update is handled. */
  onDesignStart?: (input: Parameters<AutomaticOpenContext['startDesign']>[0]) => Promise<void>;
  /**
   * ADR-233: a run Core's admission guard refuses is reported to RequestLifecycle as the DesignRun reports
   * it (DESIGN_REJECTED with the guard's code), so the request moves on exactly as in production. On by
   * default; `false` leaves a refused run unreported, for a script that reports its outcome itself.
   */
  reportRefusals?: boolean;
  /** Runs before a started design meets the admission guard (e.g. to stand in for a task an older release made). */
  beforeDesignAdmission?: (input: Parameters<AutomaticOpenContext['startDesign']>[0]) => Promise<void>;
}

/** A thin view of a request the conversation opened. */
export interface RequestView { requestId: string; stage: string; rev: number; taskId: string; title: string }

export class ConversationHarness {
  readonly t: Transcript = { inbound: [], sent: [], opened: [], revisions: [], kept: [], designs: [], deliveries: [],
    answers: new Map(), paidCalls: [], steps: [] };
  /** Virtual milliseconds since the conversation began. */
  clock = 0;
  private readonly chats = new Set<string>();
  private readonly messageIds = new Map<string, number>();
  private readonly inbox = new Map<string, ChatInboxView>();
  private readonly objects = new Map<string, LifecycleState>();
  private readonly queue: Pending[] = [];
  private readonly settleKeys = new Set<string>();
  private readonly sentKeys = new Set<string>();
  private readonly transcripts: string[] = [];
  private readonly pdfTexts = new Map<string, string>();
  private readonly files = new Map<string, Buffer>();
  private nextUpdate: number;
  private seq = 0;
  private settleSeq = 0;
  private cause: number | null = null;
  private step = -1;
  readonly app: ReturnType<typeof createApp>;
  /** ADR-200: what the office reading says, by an office member's words (no paid call); and what it was asked. */
  readonly officeReads = new Map<string, (input: OfficeModelInput) => OfficeModelDecision | null>();
  readonly officeAsked: OfficeModelInput[] = [];
  /** Inspect authoritative task state; a polite answer alone is not a durable hold. */
  async taskState(requestId: string) {
    return withRlsContext(this.o.db, SCOPE, async trx => (await sql<{state:string;version:number}>`
      SELECT t.state,t.version::integer AS version FROM hawa.tasks t
      JOIN hawa.requests r ON r.tenant_id=t.tenant_id AND r.current_task_id=t.id
      WHERE r.tenant_id=${TENANT}::uuid AND r.request_id=${requestId}::uuid`.execute(trx)).rows[0]);
  }
  private readonly core: ReturnType<typeof createCoreClient>;
  private readonly internal: { post<T>(path: string, body: unknown): Promise<T> };
  private readonly senderDeps: TelegramSenderDeps;
  private realFetch = globalThis.fetch;

  constructor(private readonly o: HarnessOptions) {
    this.nextUpdate = 1_700_000_000 + Math.floor(Math.random() * 200_000_000);
    vi.stubEnv('HAWA_WORKER_TOKEN', o.workerToken);
    vi.stubEnv('HAWA_CORE_INTERNAL_URL', CORE);
    vi.stubEnv('RESTATE_INGRESS_URL', RESTATE);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', o.office.map((p) => String(p.id)).join(','));
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '1000000');
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '100000');
    vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091');
    vi.stubEnv('TELEGRAM_BOT_USERNAME', 'hawa_office_bot');
    const bridge = {
      downloadFile: async (id: string) => this.files.get(id) ?? null,
      dispatchOutboundMessage: async () => ({ success: true }),
      answerCallbackQuery: async () => true,
    };
    const officeModel: OfficeIntentModel = { read: async (input) => {
      this.officeAsked.push(input);
      return this.officeReads.get(input.text)?.(input) ?? null;
    } };
    this.app = createApp({ db: o.db, requesterIntentModel: null, officeIntentModel: officeModel, telegramBridge: bridge,
      deliverableStore: this.store } as any);
    const appFetch = ((url: string, init?: RequestInit) => this.app.request(url, init)) as typeof fetch;
    this.core = createCoreClient({ baseUrl: CORE, token: o.workerToken, fetch: appFetch });
    this.internal = { post: async <T>(path: string, body: unknown): Promise<T> => {
      const res = await this.app.request(`${CORE}/v1${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${o.workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      // A refusal fails the step here; the conversation's own checks say what it cost.
      if (!res.ok) throw new Error(`Core HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json() as Promise<T>;
    } };
    const self = this;
    this.senderDeps = {
      db: o.db,
      botToken: () => ['conversation', 'bot'].join('_'),
      bridge: () => ({
        async dispatchOutboundMessage(chatId, message) { return self.telegram(String(chatId), message.text, 'text'); },
        async dispatchOutboundDocument(chatId, _bytes, filename) { return self.telegram(String(chatId), filename, 'document'); },
        async dispatchOutboundPhoto(chatId, _photo, caption) { return self.telegram(String(chatId), caption ?? '', 'photo'); },
      }),
      readExportBytes: readStoredExportBytes,
      readDraftImage: async (ref: any) => (ref?.id ? this.exports.get(ref.id)?.bytes ?? null : null),
      officeChatIds: () => o.office.map((p) => String(p.id)),
      markRetryDelaysMs: [5],
      // ADR-240: the worker's own canary sink, configured as production configures it (HAWA_CANARY_CHAT_ID).
      canaryChatId: () => canaryChatIdFromEnv(process.env),
    } as TelegramSenderDeps;
    this.installFetch();
  }

  // -------------------------------------------------------------------------------------------
  // The world outside Core: Telegram, model providers, Docling, Restate's ingress
  // -------------------------------------------------------------------------------------------

  private pendingKey = '';
  private telegram(chatId: string, text: string, kind: Sent['kind']): { success: true; messageId: string } {
    const messageId = this.nextMessageId(chatId);
    this.t.sent.push({ seq: ++this.seq, at: this.clock, chatId, messageId, key: this.pendingKey, text, kind,
      cause: this.cause, step: this.step });
    return { success: true, messageId: String(messageId) };
  }

  private installFetch(): void {
    const self = this;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${RESTATE}/OfficeDecisionGateway/decide`) return self.gateway(JSON.parse(String(init?.body)));
      if (url === `${RESTATE}/OfficeDecisionGateway/retryDesign`) return self.retryGateway(JSON.parse(String(init?.body)));
      if (url.includes('api.openai.com/v1/audio/transcriptions')) {
        const text = self.transcripts.shift();
        return Response.json({ text: text ?? '' });
      }
      if (/api\.openai\.com|anthropic\.com|generativelanguage\.googleapis\.com|api\.canva\.com/.test(url)) {
        self.t.paidCalls.push(url);
        return new Response('{"error":"no paid calls in the conversation harness"}', { status: 503 });
      }
      if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: true });
      return self.realFetch(input, init);
    });
    vi.spyOn(DoclingParser.prototype, 'parse').mockImplementation(async (id: string, raw: string | Uint8Array) => {
      const bytes = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
      const text = self.pdfTexts.get(sha(bytes)) ?? '';
      const chunks = text ? [{ chunkId: randomUUID(), documentId: id, pageNumber: 1, text, sha256: sha(text), tokenCountEstimate: 10,
        metadata: { sourceKind: 'docling_native_pdf', sourceId: 'brief.pdf', mimeType: 'application/pdf',
          coordinates: { x: 10, y: 10, width: 100, height: 15 }, coordinateSystem: 'top_left_points' } }] : [];
      return { documentId: id, title: 'brief.pdf', sourceSha256: sha(bytes), tables: [], images: [],
        extraction: { version: PDF_EXTRACTOR_VERSION, pageCount: 1, limitations: [] }, chunks } as any;
    });
  }

  /** Restate's ingress for the OfficeDecisionGateway: checked as the worker checks it, then the object. */
  private async gateway(envelope: SignedOfficeDecision): Promise<Response> {
    if (checkSignedOfficeDecision(envelope, this.o.workerToken) !== 'ok') return Response.json({ title: 'unsigned' }, { status: 401 });
    const object = this.objectFor(envelope.event.requestId);
    try {
      const result = envelope.event.kind === 'deliver'
        ? await recordOfficeDeliveryStart(object, this.internal, envelope.event as OfficeDeliveryStartEvent)
        : await recordOfficeRevision(object, this.internal, envelope.event as OfficeRevisionEvent);
      return Response.json(result);
    } catch (error) {
      return Response.json({ title: String(error) }, { status: 409 });
    }
  }

  /** ADR-142's retry through the office gateway: checked as the worker checks it, then the object. */
  private async retryGateway(envelope: { v: 1; event: OfficeRetryEvent; signature: string }): Promise<Response> {
    if (checkSignedOfficeRetry(envelope, this.o.workerToken) !== 'ok') return Response.json({ title: 'unsigned' }, { status: 401 });
    try {
      const result = await recordOfficeRetry(this.objectFor(envelope.event.requestId), this.internal, envelope.event);
      await this.drain();
      return Response.json(result);
    } catch (error) {
      return Response.json({ title: String(error) }, { status: 409 });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Worker objects: ChatInbox, TelegramSender, RequestLifecycle
  // -------------------------------------------------------------------------------------------

  private nextMessageId(chatId: string): number {
    const next = (this.messageIds.get(chatId) ?? 100) + 1;
    this.messageIds.set(chatId, next);
    return next;
  }

  /**
   * TelegramSender: one message, fenced by its real send mark. Sends run one at a time, in the order
   * they were asked for (production has one sender per chat; one queue here keeps the log exact).
   */
  private sending: Promise<unknown> = Promise.resolve();
  private send(message: OutboundMessage): Promise<SendResult> {
    const run = async () => {
      this.pendingKey = message.key;
      try {
        return await handleSend({ run: (_n, action) => action(), sendTo: (alert) => { this.background(this.sendOnce(alert)); } }, this.senderDeps, message);
      } finally {
        this.pendingKey = '';
      }
    };
    const result = this.sending.then(run, run);
    this.sending = result.catch(() => undefined);
    return result;
  }

  private async sendOnce(message: OutboundMessage): Promise<void> {
    if (this.sentKeys.has(message.key)) return;
    this.sentKeys.add(message.key);
    await this.send(message);
  }

  private inboxContext(chatId: string): InboxContext {
    const self = this;
    const sends: Array<Promise<unknown>> = [];
    const ctx: InboxContext & { flush(): Promise<void> } = {
      get: async <T>(name: string) => (name === 'inbox' ? (self.inbox.get(chatId) ?? null) as T | null : null),
      set: (name, value) => { if (name === 'inbox') self.inbox.set(chatId, value as ChatInboxView); },
      run: (_name, action) => action(),
      sleep: async () => undefined,
      now: async () => Date.now(),
      sendNotice: (message) => { const sent = self.sendOnce(message); sends.push(sent); self.background(sent); },
      sendLifecycleOpen: async (requestId, event) => {
        await Promise.all(sends.splice(0));
        await self.open(requestId, event as OpenAutomaticEvent | OpenManualEvent);
      },
      sendLifecycleDecision: async (requestId, event) => { await self.requesterDecision(requestId, event); },
      // ADR-230: a requester's cancel withdraws the request through its own object.
      sendLifecycleWithdraw: async (requestId, event) => {
        await Promise.all(sends.splice(0));
        await recordWithdraw(self.objectFor(requestId), self.internal, event);
        await self.drain();
      },
      scheduleSettle: (input, delayMs, key) => {
        if (self.settleKeys.has(key)) return;
        self.settleKeys.add(key);
        self.queue.push({ due: self.clock + delayMs, seq: ++self.settleSeq, chatId, input, key });
      },
      flush: async () => { await Promise.all(sends.splice(0)); },
    };
    return ctx;
  }

  private objectFor(requestId: string): AutomaticOpenContext {
    return {
      key: requestId,
      get: async () => this.objects.get(requestId) ?? null,
      run: async (_n, action) => action(),
      set: (_n, value) => { this.objects.set(requestId, value); },
      send: (message) => { this.background(this.sendOnce(message)); },
      startDesign: (input) => {
        const run: Transcript['designs'][number] = { requestId, taskId: input.taskId, runId: input.lifecycle.runId, round: input.lifecycle.round };
        this.t.designs.push(run);
        this.background(this.admit(requestId, input, run));
      },
      startDelivery: (input) => { this.t.deliveries.push(input.deliveryId); },
      setChatMode: (chatId, id) => {
        const prior = this.inbox.get(chatId);
        if (prior?.mode !== 'lifecycle') this.inbox.set(chatId, { v: 1, lastUpdateId: prior?.lastUpdateId ?? 0,
          lastOutcome: prior?.lastOutcome ?? 'handled', at: prior?.at ?? Date.now(), mode: 'lifecycle', requestId: id });
      },
    } as AutomaticOpenContext;
  }

  /**
   * ADR-233: the design-run boundary as production has it. The DesignRun's first Studio call passes
   * Core's admission guard before anything is spent; only then does the requester hear that the round
   * started (its `startNotice`). A refused run reports DESIGN_REJECTED with the guard's code.
   */
  private async admit(requestId: string, input: Parameters<AutomaticOpenContext['startDesign']>[0],
    run: Transcript['designs'][number]): Promise<void> {
    if (this.o.beforeDesignAdmission) await this.o.beforeDesignAdmission(input);
    const refused = await withRlsContext(this.o.db, SCOPE, (trx) => assertNativeRevisionAdmission(trx, TENANT, input.taskId))
      .then(() => undefined, (error: { code?: string }) => error?.code ?? String(error));
    if (refused) run.refused = refused;
    else if (input.startNotice) {
      await this.sendOnce({ v: 1, key: input.startNotice.key, chatId: input.startNotice.chatId, kind: 'text', text: input.startNotice.text,
        ...(input.startNotice.parseMode ? { parseMode: input.startNotice.parseMode } : {}), class: 'critical',
        tenantId: input.tenantId, taskId: input.taskId } as OutboundMessage);
    }
    if (refused && this.o.reportRefusals !== false) {
      const finished = { v: 1 as const, eventId: `dr-finished:${input.lifecycle.runId}`, requestId, runId: input.lifecycle.runId,
        round: input.lifecycle.round, taskId: input.taskId, report: { status: 'DESIGN_REJECTED', code: refused } };
      this.finished.push(finished);
      await recordDesignFinished(this.objectFor(requestId), this.internal, finished);
    }
    if (this.o.onDesignStart) await this.o.onDesignStart(input);
  }

  private async open(requestId: string, event: OpenAutomaticEvent | OpenManualEvent): Promise<void> {
    const object = this.objectFor(requestId);
    const auto = event.draft.autoGenerate === true;
    this.t.opened.push({ requestId, chatId: event.chatId, draft: event.draft as Record<string, any>, step: this.step, auto });
    if (auto) await openAutomaticRequest(object, this.internal, event as OpenAutomaticEvent);
    else await openManualRequest(object as any, this.internal, event as OpenManualEvent);
    await this.drain();
  }

  /** Every requester decision ChatInbox sent, as sent, so a test can deliver one again (a replay). */
  readonly decisions: Array<RequesterDecisionEvent & { newTaskId: string }> = [];
  async replayRequesterDecision(i: number): Promise<void> {
    const event = this.decisions[i];
    if (!event) throw new Error(`no requester decision ${i}`);
    await recordRequesterDecision(this.objectFor(event.requestId), this.internal, event);
    await this.drain();
  }

  private async requesterDecision(requestId: string, event: RequesterDecisionEvent & { newTaskId: string }): Promise<void> {
    this.decisions.push(event);
    this.t.revisions.push({ requestId, directive: event.directive, step: this.step });
    await recordRequesterDecision(this.objectFor(requestId), this.internal, event);
    await this.drain();
  }

  /** Fire-and-forget work (a one-way send), awaited by `drain` before the next step. */
  private readonly inFlight: Array<Promise<unknown>> = [];
  private background(work: Promise<unknown>): void { this.inFlight.push(work); }

  /** Lets every fire-and-forget send finish, including those they start. */
  private async drain(): Promise<void> {
    while (this.inFlight.length) await Promise.all(this.inFlight.splice(0));
  }

  private record(updateId: number, answer: Record<string, any>): void {
    this.t.answers.set(updateId, answer);
    if (answer?.lifecycleAction === 'late-change' && answer.requestId) {
      this.t.kept.push({ requestId: answer.requestId, step: this.step, stage: answer.requestStage });
    }
  }

  /** ChatInbox.handleUpdate for one update, with its answer recorded. */
  private async deliver(chatId: string, update: Record<string, any>): Promise<void> {
    const ctx = this.inboxContext(chatId) as InboxContext & { flush(): Promise<void> };
    this.cause = update.update_id;
    const core = { intake: async (...args: Parameters<typeof this.core.intake>) => {
      const answer = await this.core.intake(...args);
      if (answer.kind === 'done') this.record(update.update_id, answer as unknown as Record<string, any>);
      return answer;
    }, park: async (u: unknown, reason: string) => { this.t.answers.set(update.update_id, { parked: reason }); } };
    try {
      await handleUpdate(ctx, { v: 1, update: update as any }, core as any);
      await ctx.flush();
      await this.drain();
    } finally {
      this.cause = null;
    }
  }

  private async runSettle(p: Pending): Promise<void> {
    const ctx = this.inboxContext(p.chatId) as InboxContext & { flush(): Promise<void> };
    const updateId = Number((p.input.update as { update_id: number }).update_id);
    this.cause = updateId;
    const core = { intake: async (...args: Parameters<typeof this.core.intake>) => {
      const answer = await this.core.intake(...args);
      if (answer.kind === 'done' && (answer as { lifecycleAction?: string }).lifecycleAction !== 'settle-later') {
        this.record(updateId, answer as unknown as Record<string, any>);
      }
      return answer;
    }, park: async () => undefined };
    try {
      await settleUpdate(ctx, p.input, core as any);
      await ctx.flush();
      await this.drain();
    } finally {
      this.cause = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Virtual time
  // -------------------------------------------------------------------------------------------

  /**
   * Moves every row `ms` into the past. Each test file has a database of its own and runs its
   * conversations one after another, so the whole database moves: what an earlier conversation left
   * only moves further back. The voice ledger is immutable by design, and nothing reads its times.
   */
  private async shift(ms: number): Promise<void> {
    if (ms <= 0) return;
    const interval = `${ms / 1000} seconds`;
    await sql`UPDATE hawa.inbox_events SET received_at = received_at - ${interval}::interval
      WHERE tenant_id = ${TENANT}::uuid AND source_account_id NOT LIKE 'lifecycle_voice_%'`.execute(this.o.owner);
    await sql`UPDATE hawa.requests SET created_at = created_at - ${interval}::interval, updated_at = updated_at - ${interval}::interval
      WHERE tenant_id = ${TENANT}::uuid`.execute(this.o.owner);
    await sql`UPDATE hawa.tasks SET created_at = created_at - ${interval}::interval
      WHERE tenant_id = ${TENANT}::uuid`.execute(this.o.owner);
  }

  /** Lets `ms` of virtual time pass, running every settle that falls due, in order. */
  async wait(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      this.queue.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const next = this.queue[0];
      if (!next || next.due > target) break;
      this.queue.shift();
      await this.shift(next.due - this.clock);
      this.clock = Math.max(this.clock, next.due);
      await this.runSettle(next);
    }
    await this.shift(target - this.clock);
    this.clock = target;
  }

  /** Lets everything settle: every scheduled settle runs (as they would within minutes). */
  async settleAll(limitMs = 20 * 60_000): Promise<void> {
    await this.wait(limitMs);
  }

  // -------------------------------------------------------------------------------------------
  // What a person sends
  // -------------------------------------------------------------------------------------------

  chat(type: 'private' | 'group' = 'private', id?: number): string {
    const chatId = String(id ?? (type === 'private' ? 64_000_000 + Math.floor(Math.random() * 30_000_000)
      : -(1_000_000_000_000 + Math.floor(Math.random() * 900_000_000))));
    this.chats.add(chatId);
    this.chatTypes.set(chatId, type === 'group' ? 'supergroup' : 'private');
    return chatId;
  }
  private readonly chatTypes = new Map<string, string>();

  private message(chatId: string, from: Person, fields: Record<string, unknown>): { update: Record<string, any>; messageId: number } {
    const messageId = this.nextMessageId(chatId);
    const update = { update_id: ++this.nextUpdate, message: { message_id: messageId, date: 1_790_000_000 + Math.floor(this.clock / 1000),
      from: { id: from.id, is_bot: false, first_name: from.name }, chat: { id: Number(chatId), type: this.chatTypes.get(chatId) ?? 'private' },
      ...fields } };
    return { update, messageId };
  }

  /** Sends one update after `after` ms; answers with the inbound record. */
  async post(chatId: string, from: Person, kind: string, fields: Record<string, unknown>, after = 20_000, label = ''): Promise<Inbound> {
    this.chats.add(chatId);
    await this.wait(after);
    this.step = this.t.steps.length;
    this.t.steps.push(label || kind);
    const { update, messageId } = this.message(chatId, from, fields);
    const text = String((fields as { text?: unknown; caption?: unknown }).text ?? (fields as { caption?: unknown }).caption ?? '');
    const inbound: Inbound = { step: this.step, at: this.clock, updateId: update.update_id, chatId, messageId, from, kind, text, update };
    this.t.inbound.push(inbound);
    await this.deliver(chatId, update);
    return inbound;
  }

  /** An edit of an earlier message (Telegram sends an `edited_message` with a new update id). */
  async edit(of: Inbound, text: string, after = 20_000): Promise<Inbound> {
    await this.wait(after);
    this.step = this.t.steps.length;
    this.t.steps.push('edit');
    const original = of.update.message;
    const field = typeof original.caption === 'string' || original.photo ? 'caption' : 'text';
    const update = { update_id: ++this.nextUpdate, edited_message: { ...original, [field]: text,
      edit_date: 1_790_000_000 + Math.floor(this.clock / 1000) } };
    const inbound: Inbound = { step: this.step, at: this.clock, updateId: update.update_id, chatId: of.chatId, messageId: of.messageId,
      from: of.from, kind: 'edit', text, update };
    this.t.inbound.push(inbound);
    await this.deliver(of.chatId, update);
    return inbound;
  }

  /** A button pressed under an old message. */
  async press(chatId: string, from: Person, onMessage: number, data: string, after = 20_000): Promise<Inbound> {
    await this.wait(after);
    this.step = this.t.steps.length;
    this.t.steps.push('button');
    const update = { update_id: ++this.nextUpdate, callback_query: { id: `cb-${this.nextUpdate}`, data,
      from: { id: from.id, is_bot: false, first_name: from.name },
      message: { message_id: onMessage, chat: { id: Number(chatId), type: this.chatTypes.get(chatId) ?? 'private' }, date: 1_790_000_000 } } };
    const inbound: Inbound = { step: this.step, at: this.clock, updateId: update.update_id, chatId, messageId: onMessage, from,
      kind: 'button', text: data, update };
    this.t.inbound.push(inbound);
    await this.deliver(chatId, update);
    return inbound;
  }

  /** A photo file the bot can download. */
  photoFile(n: number): string {
    const id = `photo-${n}-${this.nextUpdate}`;
    this.files.set(id, png(n));
    return id;
  }

  /** A voice note whose transcription is `words`. */
  async voiceFile(words: string): Promise<{ file_id: string; duration: number; mime_type: string; file_size: number }> {
    const audio = await readFile(new URL('../../../../packages/testkit/fixtures/voice/silence-one-second.ogg', import.meta.url));
    const id = `voice-${this.nextUpdate}-${this.files.size}`;
    this.files.set(id, audio);
    this.transcripts.push(words);
    return { file_id: id, duration: 12, mime_type: 'audio/ogg', file_size: audio.length };
  }

  /** A PDF whose reading is `words`. */
  async pdfFile(words: string): Promise<{ file_id: string; file_name: string; mime_type: string; file_size: number }> {
    const base = await readFile(new URL('../../../../services/docling/fixtures/two-pages.pdf', import.meta.url));
    const bytes = Buffer.concat([base, Buffer.from(`\n%${randomUUID()}\n`)]);
    const id = `pdf-${this.nextUpdate}-${this.files.size}`;
    this.files.set(id, bytes);
    this.pdfTexts.set(sha(bytes), words);
    return { file_id: id, file_name: 'brief.pdf', mime_type: 'application/pdf', file_size: bytes.length };
  }

  // -------------------------------------------------------------------------------------------
  // The office
  // -------------------------------------------------------------------------------------------

  /** Parks drafts other conversations left in the office queue, so this one sees only its own. */
  async emptyOfficeQueue(): Promise<void> {
    await withRlsContext(this.o.db, SCOPE, (trx) => sql`UPDATE hawa.requests SET stage = 'rejected'
      WHERE tenant_id = ${TENANT}::uuid AND stage = 'in_review' AND NOT (chat_id = ANY(${[...this.chats]}::text[]))`.execute(trx));
  }

  /** The stored exports the Desk's approval pins (a stand-in for the Canva export store). */
  private readonly exports = new Map<string, { format: 'png' | 'pptx'; bytes: Buffer }>();
  private readonly store = {
    captureEvidenceRequired: true,
    verifyCurrentSource: async () => ({ ok: true as const, capturedVersion: '300', observedVersion: '300' }),
    find: async (_t: string, _u: string, _task: string, ids: string[]) => ids.filter((id) => this.exports.has(id)).map((id) => {
      const file = this.exports.get(id)!;
      return { artifactId: id, format: file.format, sha256: sha(file.bytes), byteSize: file.bytes.length };
    }),
    read: async (_t: string, _u: string, _task: string, id: string) => this.exports.get(id)?.bytes ?? null,
  };

  /**
   * The design run of a request finished with a Canva draft: its binding, its PNG and PPTX exports and a
   * passing check, then RequestLifecycle's `recordDesignFinished`, which moves it to the office and
   * sends the requester's and the office's messages.
   */
  async draftReady(requestId: string, after = 3 * 60_000): Promise<void> {
    await this.wait(after);
    this.step = this.t.steps.length;
    this.t.steps.push('office: draft ready');
    const state = this.objects.get(requestId) as any;
    if (!state || !('runId' in state)) throw new Error(`request ${requestId} has no design run`);
    const taskId: string = state.taskId;
    const clientId: string = state.designInput.clientId;
    const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const pngBytes = Buffer.from(`png of ${taskId} ${state.rev}`);
    const pptxBytes = Buffer.from(`pptx of ${taskId} ${state.rev}`);
    const pngId = randomUUID();
    const pptxId = randomUUID();
    this.exports.set(pngId, { format: 'png', bytes: pngBytes });
    this.exports.set(pptxId, { format: 'pptx', bytes: pptxBytes });
    await withRlsContext(this.o.db, SCOPE, async (trx) => {
      await new CanvaBindingRepository(trx).createBinding({ tenantId: TENANT, taskId, clientId, canvaDesignId: designId,
        editUrl: `https://www.canva.com/design/${designId}/edit` }, trx);
      const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
        .where('tenant_id', '=', TENANT).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      for (const [id, format, bytes] of [[pngId, 'png', pngBytes], [pptxId, 'pptx', pptxBytes]] as const) {
        const operationId = randomUUID();
        await sql`INSERT INTO hawa.canva_remote_operations
          (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
          VALUES (${operationId}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${`capture-${operationId}`},
            ${sha(bytes)}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
            ${JSON.stringify({ format, designUpdatedAt: '300' })}::jsonb)`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
          VALUES (${id}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${operationId}::uuid, ${format}, ${sha(bytes)}, ${bytes})`.execute(trx);
      }
    });
    const finished = { v: 1 as const, eventId: `dr-finished:${state.runId}`,
      requestId, runId: state.runId, round: state.round ?? 0, taskId,
      report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId } };
    this.finished.push(finished);
    await recordDesignFinished(this.objectFor(requestId), this.internal, finished);
    const after2 = this.objects.get(requestId) as any;
    const revisionId = after2?.outcome?.revisionId;
    if (revisionId) {
      const report = { exportArtifactId: pptxId, exportSha256: sha(pptxBytes), captureVersion: '300' };
      await withRlsContext(this.o.db, SCOPE, async (trx) => {
        const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
          .where('tenant_id', '=', TENANT).where('design_revision_id', '=', revisionId).executeTakeFirst();
        if (!firstQc) return;
        await sql`INSERT INTO hawa.qc_runs (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status,
            critical_pass, report, report_sha256, started_at)
          VALUES (${randomUUID()}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${revisionId}::uuid, ${firstQc.qc_profile_id}::uuid, 2,
            'passed', true, ${JSON.stringify(report)}::jsonb, ${sha(JSON.stringify(report))}, clock_timestamp() + interval '1 minute')`.execute(trx);
      });
    }
    await this.drain();
  }

  /** ADR-230 addendum: every design finish reported, in order, so a test can report one again (a replay). */
  private readonly finished: Array<Parameters<typeof recordDesignFinished>[2]> = [];
  async replayDesignFinished(requestId: string, i = 0): Promise<void> {
    const event = this.finished.filter((f) => f.requestId === requestId)[i];
    if (!event) throw new Error(`request ${requestId} reported no finish ${i}`);
    await recordDesignFinished(this.objectFor(requestId), this.internal, event);
    await this.drain();
  }

  /** An office member writes in their own private chat with the bot (a decision, or anything else). */
  async officeSays(member: Person, text: string, options: { replyTo?: number; after?: number } = {}): Promise<Inbound> {
    const chatId = String(member.id);
    this.chats.add(chatId);
    this.chatTypes.set(chatId, 'private');
    return this.post(chatId, member, 'office', { text, ...(options.replyTo ? { reply_to_message: { message_id: options.replyTo,
      from: { id: 7_000_001, is_bot: true, first_name: 'Hawa' } } } : {}) }, options.after ?? 60_000, `office: ${text}`);
  }

  /** The message id of the draft alert a member was sent for a request (its latest revision). */
  alertFor(member: Person, requestId: string): number | undefined {
    return [...this.t.sent].reverse().find((s) => s.chatId === String(member.id) && s.key.startsWith(`${requestId}:`) && s.key.includes(':office-alert'))?.messageId;
  }

  /**
   * Delivery finished: Core's rows as the Delivery workflow leaves them, and the requester's notice sent
   * under the Delivery workflow's own key (`dl-<task>-<approval>:notice`).
   */
  async delivered(requestId: string, after = 60_000): Promise<void> {
    await this.wait(after);
    this.step = this.t.steps.length;
    this.t.steps.push('office: delivered');
    const state = this.objects.get(requestId) as any;
    const approvalId: string = state?.officeRevision?.approvalId ?? randomUUID();
    await withRlsContext(this.o.db, SCOPE, (trx) => sql`UPDATE hawa.requests SET stage = 'delivered', rev = rev + 1, updated_at = now()
      WHERE tenant_id = ${TENANT}::uuid AND request_id = ${requestId}::uuid`.execute(trx));
    if (state) this.objects.set(requestId, { ...state, stage: 'delivered', rev: state.rev + 1 });
    const chatId: string = state.chatId;
    await this.sendOnce({ v: 1, key: `dl-${state.taskId}-${approvalId}:notice`, chatId, kind: 'text', class: 'critical',
      text: `Here is your design: ${state.title ?? 'your design'}.`, tenantId: TENANT, taskId: state.taskId } as OutboundMessage);
    await this.drain();
  }

  // -------------------------------------------------------------------------------------------
  // Reading the result
  // -------------------------------------------------------------------------------------------

  /** The requests this conversation's chats hold now, as Core has them. */
  async requests(chatId: string): Promise<RequestView[]> {
    return (await sql<{ request_id: string; stage: string; rev: string; current_task_id: string; title: string | null }>`
      SELECT r.request_id::text, r.stage, r.rev, r.current_task_id::text, coalesce(root.title, t.title) AS title
      FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
      LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
      WHERE r.tenant_id = ${TENANT}::uuid AND r.chat_id = ${chatId} ORDER BY r.created_at, r.request_id`.execute(this.o.owner)).rows
      .map((r) => ({ requestId: r.request_id, stage: r.stage, rev: Number(r.rev), taskId: r.current_task_id, title: r.title ?? '' }));
  }

  /** The photos a request's current task carries (its own photo, an album's, material added later). */
  async photosOf(requestId: string): Promise<number> {
    const opened = this.t.opened.find((o) => o.requestId === requestId);
    const shas = new Set<string>();
    if (opened?.draft.lifecycleImage?.sha256) shas.add(opened.draft.lifecycleImage.sha256);
    for (const image of opened?.draft.lifecycleAlbum?.images ?? []) if (image?.sha256) shas.add(image.sha256);
    const files = (await sql<{ sha256: string }>`SELECT DISTINCT f.sha256 FROM hawa.task_files f
      JOIN hawa.tasks t ON t.tenant_id = f.tenant_id AND t.id = f.task_id
      WHERE f.tenant_id = ${TENANT}::uuid AND t.request_id = ${requestId}::uuid AND f.role = 'reference_image'`.execute(this.o.owner)).rows;
    for (const f of files) shas.add(f.sha256);
    return shas.size;
  }

  /** What the bot said in a chat, in order. */
  said(chatId: string): Sent[] {
    return this.t.sent.filter((s) => s.chatId === String(chatId));
  }

  /** What the bot said in a chat because of one inbound message (its answer, a settle's, an open's). */
  saidFor(inbound: Inbound): Sent[] {
    return this.t.sent.filter((s) => s.chatId === inbound.chatId && s.step === inbound.step);
  }

  /** The last message the bot sent in a chat (optionally: whose key matches). */
  lastBot(chatId: string, key?: RegExp): Sent | undefined {
    return [...this.said(chatId)].reverse().find((s) => !key || key.test(s.key));
  }
}
