/**
 * Whether Canva will take the office's next design (ADR-288).
 *
 * /v1/health said Canva "unverified" for good: nothing ever asked Canva, so an expired or withdrawn
 * connection showed only when a design failed at the transfer. This asks Canva, at most once per
 * check interval, with the connection designs transfer under (the Primary Operator's): the token is
 * refreshed if it is due (the same guarded rotation every design uses, CanvaConnectService
 * .authorizedClient), then GET /users/me, which is free, reads nothing of the office's designs and
 * changes nothing. No design is created, no paid call is made.
 *
 *  - connected:   Canva honoured the token (2xx; a 403 is an honoured token without that scope).
 *  - expired:     there is no usable authorization: never connected, disconnected, or a refresh Canva
 *                 refused (invalid_grant) or whose result was lost. A person must connect again.
 *  - revoked:     Canva refused a token Hawa holds as current (401), or refused the integration's own
 *                 refresh credentials: access was withdrawn on Canva's side.
 *  - unreachable: Canva did not answer (network, 429, 5xx). One such check is retried before it is
 *                 reported: this Mac's connection drops for a moment more often than Canva does.
 *  - unconfigured: the Canva integration settings are missing.
 *
 * Moving into expired or revoked alerts every office member once per connection (the outbox key names
 * the connection's generation, which a reconnect changes); unreachable for 30 minutes alerts once a day.
 */
import { createHash } from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { CanvaHttpError } from '@hawa/integrations';
import { CanvaFlowError } from './canva-flow-error.js';
import { log } from '../logging.js';

export type CanvaReadinessStatus = 'connected' | 'expired' | 'revoked' | 'unreachable' | 'unconfigured' | 'unverified';

export interface CanvaReadiness {
  status: CanvaReadinessStatus;
  /** When Canva last answered this way (a retried unreachable check keeps the previous answer's time). */
  checkedAt: string | null;
  /** When Canva was last asked. */
  attemptedAt: string | null;
  detail: string | null;
}

interface CanvaProbeService {
  configuration(): { configured: boolean };
  authorizedClient(s: { tenantId: string; actorId: string }): Promise<{ probeCurrentUser(): Promise<{ status: number }> }>;
}

export interface CanvaReadinessOptions {
  db: Kysely<Database>;
  service: CanvaProbeService;
  tenantId: string;
  /** The connection designs transfer under. */
  actorId: string;
  officeChatIds: () => readonly string[];
  /** How long an answer is kept before Canva is asked again (default 10 minutes). */
  ttlMs?: number;
  /** How soon an unanswered check is asked again (default 2 minutes). */
  retryMs?: number;
  /** How long Canva must stay unreachable before the office hears of it (default 30 minutes). */
  unreachableAlertAfterMs?: number;
  now?: () => number;
}

/** The outbox aggregate of Canva connection alerts: they are about the integration, not a task. */
export const CANVA_READINESS_AGGREGATE_ID = '00000000-0000-4000-c000-0000000ca7a0';

const ALERTS: Record<'expired' | 'revoked' | 'unreachable', string> = {
  expired: 'Canva is no longer connected to Hawa: its sign-in has expired, so new designs cannot be put into Canva '
    + 'and drafts will stop. Please connect Canva again in Hawa Desk (Settings, Canva connection), signed in to the '
    + 'office\'s Canva account.',
  revoked: 'Canva refused Hawa\'s connection: access was withdrawn on Canva\'s side, so new designs cannot be put '
    + 'into Canva and drafts will stop. Please connect Canva again in Hawa Desk (Settings, Canva connection).',
  unreachable: 'Hawa has not been able to reach Canva for more than 30 minutes, so new drafts may be delayed. '
    + 'If this Mac\'s internet is working, Canva itself may be having trouble. Hawa keeps checking; nothing needs doing yet.',
};

type Observation = { status: Exclude<CanvaReadinessStatus, 'unverified'>; detail: string | null; generation: string | null };

export class CanvaReadinessProbe {
  private last: CanvaReadiness | null = null;
  private lastAnswer: CanvaReadiness | null = null;
  private nextAt = 0;
  private inflight: Promise<CanvaReadiness> | null = null;
  private unreachableRun = 0;
  private unreachableSince: number | null = null;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly unreachableAlertAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CanvaReadinessOptions) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.retryMs = options.retryMs ?? 2 * 60_000;
    this.unreachableAlertAfterMs = options.unreachableAlertAfterMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * The answer health shows: the kept one while it is fresh; a stale one while a new check runs
   * behind it; the first check itself, for at most `waitMs`, before there is any answer.
   */
  async current(waitMs = 8_000): Promise<CanvaReadiness> {
    if (this.last && this.now() < this.nextAt) return this.last;
    const running = this.check();
    if (this.last) { running.catch(() => undefined); return this.last; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiting = new Promise<CanvaReadiness>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'unverified', checkedAt: null, attemptedAt: null,
        detail: 'The first Canva check is still running' }), waitMs);
      timer.unref?.();
    });
    try { return await Promise.race([running, waiting]); } finally { clearTimeout(timer); }
  }

  /** Asks Canva now (one check at a time), records the answer, and alerts the office if it went bad. */
  check(): Promise<CanvaReadiness> {
    this.inflight ??= this.run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(): Promise<CanvaReadiness> {
    const at = this.now();
    const attemptedAt = new Date(at).toISOString();
    let seen: Observation;
    try {
      seen = await this.observe();
    } catch (err) {
      seen = { status: 'unreachable', detail: `The check failed: ${(err as Error)?.message || String(err)}`.slice(0, 300), generation: null };
    }
    let reported: CanvaReadiness;
    if (seen.status === 'unreachable') {
      this.unreachableRun += 1;
      this.unreachableSince ??= at;
      // One unanswered check keeps the previous answer, said to be old, and is asked again soon.
      reported = this.unreachableRun < 2 && this.lastAnswer && this.lastAnswer.status !== 'unreachable'
        ? { ...this.lastAnswer, attemptedAt, detail: `Canva did not answer the last check (${seen.detail}); asking again shortly.` }
        : { status: 'unreachable', checkedAt: attemptedAt, attemptedAt, detail: seen.detail };
      this.nextAt = at + this.retryMs;
    } else {
      this.unreachableRun = 0;
      this.unreachableSince = null;
      reported = { status: seen.status, checkedAt: attemptedAt, attemptedAt, detail: seen.detail };
      this.nextAt = at + this.ttlMs;
    }
    if (reported.status !== 'unreachable' || this.unreachableRun >= 2 || !this.lastAnswer) this.lastAnswer = reported;
    this.last = reported;
    await this.alert(reported.status, seen.generation, at).catch((err) =>
      log.warn('[canva-readiness] office alert not recorded:', (err as Error)?.message || err));
    return reported;
  }

  private async observe(): Promise<Observation> {
    const { service, db, tenantId, actorId } = this.options;
    if (!service.configuration().configured) return { status: 'unconfigured', detail: 'The Canva integration settings are missing', generation: null };
    const row = await withRlsContext(db, { tenantId, userId: actorId, role: 'operator' }, async (trx) =>
      (await sql<{ status: string; generation: string | null }>`SELECT status, generation FROM hawa.canva_connections
        WHERE tenant_id = ${tenantId}::uuid AND actor_id = ${actorId}`.execute(trx)).rows[0]);
    const generation = row?.generation ?? null;
    if (!row || !['active', 'refreshing'].includes(row.status)) {
      return { status: 'expired', detail: row ? `The connection is ${row.status.replaceAll('_', ' ')}` : 'Canva has never been connected', generation };
    }
    let client: Awaited<ReturnType<CanvaProbeService['authorizedClient']>>;
    try {
      client = await service.authorizedClient({ tenantId, actorId });
    } catch (err) {
      const code = err instanceof CanvaFlowError ? err.code : null;
      if (code === 'CANVA_RECONNECT_REQUIRED') return { status: 'expired', detail: 'Canva would not renew the sign-in', generation };
      if (code === 'CANVA_TOKEN_REFRESH_REFUSED') return { status: 'revoked', detail: 'Canva refused the integration\'s refresh credentials', generation };
      if (code === 'CANVA_SETUP_REQUIRED') return { status: 'unconfigured', detail: 'The Canva integration settings are missing', generation };
      return { status: 'unreachable', detail: code ? `Renewing the sign-in failed (${code})` : `Renewing the sign-in failed: ${(err as Error)?.message || err}`, generation };
    }
    let status: number;
    try {
      ({ status } = await client.probeCurrentUser());
    } catch (err) {
      if (err instanceof CanvaHttpError && err.status === 401) return { status: 'revoked', detail: 'Canva refused the token (HTTP 401)', generation };
      return { status: 'unreachable', detail: `Canva did not answer: ${(err as Error)?.name || 'network error'}`, generation };
    }
    if ((status >= 200 && status < 300) || status === 403) return { status: 'connected', detail: null, generation };
    if (status === 401) return { status: 'revoked', detail: 'Canva refused the token (HTTP 401)', generation };
    return { status: 'unreachable', detail: `Canva answered HTTP ${status}`, generation };
  }

  /** The office hears of a bad state once: the outbox key is the record that it was told. */
  private async alert(status: CanvaReadinessStatus, generation: string | null, at: number): Promise<void> {
    let base: string | null = null;
    const connection = generation ?? 'none';
    if (status === 'expired' || status === 'revoked') base = `notify.office:canva-readiness:${status}:${connection}`;
    if (status === 'unreachable' && this.unreachableSince !== null && at - this.unreachableSince >= this.unreachableAlertAfterMs) {
      base = `notify.office:canva-readiness:unreachable:${connection}:${new Date(at).toISOString().slice(0, 10)}`;
    }
    if (!base) return;
    const members = [...new Set(this.options.officeChatIds().map((c) => c.trim()).filter(Boolean))];
    if (!members.length) return;
    const text = ALERTS[status as keyof typeof ALERTS];
    const key = base;
    await withRlsContext(this.options.db, { tenantId: this.options.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      for (const [index, chatId] of members.entries()) {
        await sql`INSERT INTO hawa.outbox_commands
            (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state, attempts, available_at)
          VALUES (${this.options.tenantId}::uuid, 'integration', ${CANVA_READINESS_AGGREGATE_ID}::uuid, 'notify.telegram',
            ${index === 0 ? key : `${key}:${chatId}`},
            ${JSON.stringify({ chatId, message: { text }, alert: 'canva-readiness', status,
              connection: createHash('sha256').update(connection).digest('hex').slice(0, 12) })}::jsonb, 'pending', 0, now())
          ON CONFLICT DO NOTHING`.execute(trx);
      }
    });
  }
}
