import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export interface EnqueueCommandParams {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  commandType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

/**
 * How long a command survives a dependency outage before it is dead-lettered.
 *
 * The schedule was 5 attempts from a 5 s base: 5, 10, 20, 40 s, then a dead letter. A Telegram or
 * Core outage of 76 seconds therefore turned every waiting "your design is ready" into a dead letter
 * that only an operator could redrive, and with no jitter every command failed by one outage came
 * back in the same second.
 *
 * Twelve attempts from a 15 s base, capped at an hour, wait about 4 h 20 min in total (15, 30, 60,
 * 120, 240, 480, 960, 1920 s, then 3600 s three times), which covers an evening's outage. A late
 * notice is worth more than none, and dead letters still degrade worker health, which pages.
 */
export const OUTBOX_MAX_ATTEMPTS = 12;
export const OUTBOX_BACKOFF_BASE_SECONDS = 15;
export const OUTBOX_BACKOFF_CAP_SECONDS = 3600;

/**
 * Delay before attempt `attempt + 1`, in seconds. Exponential, capped, with equal jitter: the
 * result lies between half the nominal delay and the whole of it, so commands failed together do
 * not return together, and no retry is ever immediate. `random` is injectable for tests.
 */
export function outboxRetryDelaySeconds(
  attempt: number,
  baseSeconds: number = OUTBOX_BACKOFF_BASE_SECONDS,
  capSeconds: number = OUTBOX_BACKOFF_CAP_SECONDS,
  random: () => number = Math.random
): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const nominal = Math.min(capSeconds, baseSeconds * Math.pow(2, Math.min(n - 1, 30)));
  return nominal / 2 + random() * (nominal / 2);
}

/**
 * Where a request's pictures sit inside a command's payload. Core copies the intake payload into
 * `task.created` and `task.dispatch`, and a reference photo came with it (base64, several MB), so
 * every claim carried it to the worker and the dispatcher sent it on to Restate's journal. No handler
 * reads it: the studio takes the request's pictures from its `task.created` event. Claims strip them.
 */
export const OUTBOX_PAYLOAD_PICTURE_PATHS = [
  '{referenceImageBase64}',
  '{studioOptions,referenceImageBase64}',
  '{payload,referenceImageBase64}',
  '{payload,studioOptions,referenceImageBase64}',
] as const;

/**
 * A command as a consumer holds it while acting: only what a handler needs, never the whole row.
 *
 * `claim_token` is the claim's lease expiry (`leased_until`, as Postgres prints it, to the
 * microsecond). A command is claimed again only after the lease has run out or its holder released
 * it, and a new lease always ends later than any earlier one, so the value identifies this holder's
 * claim: every write of a result checks it, and a holder whose lease was taken over changes nothing.
 * `reclaimed` is true when the lease of an earlier holder had run out (it stopped mid-command).
 */
export interface OutboxClaim {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  command_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  /** 'failed' when this claim found the command's leases had run out too often (see claimDue). */
  state: 'leased' | 'failed';
  attempts: number;
  claim_token: string;
  reclaimed: boolean;
}

/** The result a holder records for its claim, in the order the consumer classifies errors. */
export type OutboxClaimFailure = 'retry' | 'permanent' | 'uncertain';

const UNCERTAIN_PREFIX = 'DELIVERY_UNCERTAIN:';

export class OutboxRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Claims up to `limit` due commands in one short statement, for a consumer to act on after its
   * transaction has committed. Nothing a handler does (a Telegram upload may take a minute) happens
   * while a transaction is open: the pool kills a session idle in a transaction after 30 s, and it
   * used to be killed after the send and before the delivery was recorded, so the send was repeated.
   *
   * A command whose lease ran out (its holder stopped mid-command) is claimed again and that counts
   * as an attempt, so a command that stops every worker that takes it cannot loop for ever: when
   * the count reaches `maxAttempts` it is dead-lettered here as uncertain, since nobody knows what
   * the holders did, and returned with state 'failed' for the consumer to report. `exceptIds` are
   * never claimed (the consumer's own batch, already handled once).
   */
  async claimDue(
    limit: number,
    leaseSeconds: number,
    maxAttempts: number = OUTBOX_MAX_ATTEMPTS,
    trx?: Kysely<Database>,
    options: { exceptIds?: string[] } = {}
  ): Promise<OutboxClaim[]> {
    const client = trx || this.db;
    const exceptIds = options.exceptIds || [];
    const lease = Math.max(1, leaseSeconds);
    const payload = OUTBOX_PAYLOAD_PICTURE_PATHS.reduce(
      (expr, path) => sql`(${expr} #- ${path}::text[])`,
      sql`o.payload`
    );
    const reclaimNote = 'LEASE_EXPIRED: the consumer holding this command stopped before recording a result; claimed again';
    const deadNote = `${UNCERTAIN_PREFIX} LEASE_EXPIRED: every consumer that claimed this command stopped before recording a result; whatever it sends may already have been sent`;
    const result = await sql<OutboxClaim>`
      WITH due AS (
        SELECT id, state = 'leased' AS reclaimed
        FROM outbox_commands
        WHERE (state = 'pending' OR (state = 'leased' AND leased_until < now()))
          -- Enqueuers write available_at from their own clock, so a command is due when either
          -- that clock or the database's says so: a database clock a few ms behind the app's left a
          -- command enqueued just now undue.
          AND available_at <= greatest(now(), ${new Date()}::timestamptz)
          AND NOT (id = ANY(${exceptIds}::uuid[]))
        ORDER BY available_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_commands o
      SET state = CASE WHEN due.reclaimed AND o.attempts + 1 >= ${maxAttempts} THEN 'failed'::outbox_state ELSE 'leased'::outbox_state END,
          leased_until = CASE WHEN due.reclaimed AND o.attempts + 1 >= ${maxAttempts} THEN NULL
                              ELSE now() + make_interval(secs => ${lease}::float8) END,
          attempts = o.attempts + CASE WHEN due.reclaimed THEN 1 ELSE 0 END,
          last_error = CASE WHEN NOT due.reclaimed THEN o.last_error
                            WHEN o.attempts + 1 >= ${maxAttempts} THEN ${deadNote}
                            ELSE ${reclaimNote} END
      FROM due
      WHERE o.id = due.id
      RETURNING o.id, o.tenant_id, o.aggregate_type, o.aggregate_id, o.command_type, o.idempotency_key,
        ${payload} AS payload, o.state, o.attempts,
        coalesce(o.leased_until::text, '') AS claim_token, due.reclaimed
    `.execute(client);
    return result.rows.map((r) => ({ ...r, attempts: Number(r.attempts) }));
  }

  /**
   * Moves this holder's lease on while its handler is still acting. Returns the new claim token, or
   * undefined when the claim is no longer this holder's (its lease ran out and another consumer took
   * the command, or an operator redrove it).
   */
  async renewClaim(id: string, claimToken: string, leaseSeconds: number, trx?: Kysely<Database>): Promise<string | undefined> {
    const client = trx || this.db;
    const result = await sql<{ claim_token: string }>`
      UPDATE outbox_commands
      SET leased_until = now() + make_interval(secs => ${Math.max(1, leaseSeconds)}::float8)
      WHERE id = ${id}::uuid AND state = 'leased' AND leased_until = ${claimToken}::timestamptz
      RETURNING leased_until::text AS claim_token
    `.execute(client);
    return result.rows[0]?.claim_token;
  }

  /** Marks the claimed command delivered, only if the claim is still this holder's. */
  async completeClaim(id: string, claimToken: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .updateTable('outbox_commands')
      .set({ state: 'delivered', delivered_at: new Date(), leased_until: null })
      .where('id', '=', id)
      .where('state', '=', 'leased')
      .where('leased_until', '=', sql<Date>`${claimToken}::timestamptz`)
      .returning(['id', 'state', 'attempts'])
      .executeTakeFirst();
  }

  /**
   * Records a failed attempt of the claimed command, only if the claim is still this holder's:
   * 'permanent' and 'uncertain' end it (an uncertain send is never repeated automatically), 'retry'
   * schedules the next attempt or dead-letters it at `maxAttempts`. Returns undefined when the claim
   * was lost; whoever holds the command now decides.
   */
  async failClaim(
    id: string,
    claimToken: string,
    error: string,
    outcome: OutboxClaimFailure,
    options: { attempts: number; maxAttempts?: number; backoffBaseSeconds?: number },
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const attempts = options.attempts + 1;
    const maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    const ends = outcome !== 'retry' || attempts >= maxAttempts;
    const lastError = outcome === 'uncertain' && !error.startsWith(UNCERTAIN_PREFIX) ? `${UNCERTAIN_PREFIX} ${error}` : error;
    const delaySeconds = ends ? 0 : outboxRetryDelaySeconds(attempts, options.backoffBaseSeconds ?? OUTBOX_BACKOFF_BASE_SECONDS);
    return await client
      .updateTable('outbox_commands')
      .set({
        state: ends ? 'failed' : 'pending',
        attempts,
        last_error: lastError,
        leased_until: null,
        ...(ends ? {} : { available_at: new Date(Date.now() + delaySeconds * 1000) }),
      })
      .where('id', '=', id)
      .where('state', '=', 'leased')
      .where('leased_until', '=', sql<Date>`${claimToken}::timestamptz`)
      .returning(['id', 'state', 'attempts'])
      .executeTakeFirst();
  }

  async enqueue(
    paramsOrTenantId: EnqueueCommandParams | string,
    taskIdOrTrx?: string | null | Kysely<Database>,
    destination?: string,
    payload?: Record<string, unknown>,
    optionalTrx?: Kysely<Database>
  ) {
    let row: any;
    let trx: Kysely<Database> | undefined;

    if (typeof paramsOrTenantId === 'string') {
      trx = optionalTrx;
      row = {
        tenant_id: paramsOrTenantId,
        aggregate_type: 'task',
        aggregate_id: (typeof taskIdOrTrx === 'string' ? taskIdOrTrx : null) || crypto.randomUUID(),
        command_type: destination || 'task.dispatch',
        idempotency_key: `outbox-${crypto.randomUUID()}`,
        payload: payload || {},
        state: 'pending' as const,
        attempts: 0,
        last_error: null,
      };
    } else {
      trx = taskIdOrTrx as Kysely<Database> | undefined;
      row = {
        tenant_id: paramsOrTenantId.tenantId,
        aggregate_type: paramsOrTenantId.aggregateType,
        aggregate_id: paramsOrTenantId.aggregateId,
        command_type: paramsOrTenantId.commandType,
        idempotency_key: paramsOrTenantId.idempotencyKey,
        payload: paramsOrTenantId.payload,
        available_at: paramsOrTenantId.availableAt || new Date(),
        state: 'pending' as const,
        attempts: 0,
        last_error: null,
      };
    }

    const client = trx || this.db;
    return await client
      .insertInto('outbox_commands')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .selectFrom('outbox_commands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  /**
   * The older name for `claimDue`, kept for its callers. It returned whole rows (`RETURNING *`,
   * pictures included); it now returns the same narrow claims.
   */
  async leasePending(limit: number = 10, leaseSeconds: number = 60, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

    if (typeof (client as any).executeQuery === 'function') {
      return await this.claimDue(limit, leaseSeconds, OUTBOX_MAX_ATTEMPTS, client);
    }

    // Fallback for mock DB environments without executeQuery
    const available = await client
      .selectFrom('outbox_commands')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('state', '=', 'pending'),
          eb.and([eb('state', '=', 'leased'), eb('leased_until', '<', now)]),
        ])
      )
      .limit(limit)
      .execute();

    const valid = available.filter((r: any) => !r.available_at || new Date(r.available_at) <= now);
    if (valid.length === 0) return [];

    const ids = valid.map((r: any) => r.id);

    return await client
      .updateTable('outbox_commands')
      .set({
        state: 'leased',
        leased_until: leaseUntil,
      })
      .where('id', 'in', ids)
      .returningAll()
      .execute();
  }

  async markDelivered(id: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .updateTable('outbox_commands')
      .set({
        state: 'delivered',
        delivered_at: new Date(),
        leased_until: null,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async markFailed(id: string, error: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .updateTable('outbox_commands')
      .set((eb) => ({
        state: 'failed',
        attempts: eb('attempts', '+', 1),
        last_error: error,
        leased_until: null,
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async retryOrDeadLetter(
    id: string,
    error: string,
    maxAttempts: number = OUTBOX_MAX_ATTEMPTS,
    backoffBaseSeconds: number = OUTBOX_BACKOFF_BASE_SECONDS,
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const existing = await client
      .selectFrom('outbox_commands')
      .select(['attempts'])
      .where('id', '=', id)
      .executeTakeFirst();

    const attempts = ((existing?.attempts as number) || 0) + 1;
    if (attempts >= maxAttempts) {
      return await client
        .updateTable('outbox_commands')
        .set({
          state: 'failed',
          attempts,
          last_error: error,
          leased_until: null,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      const delaySeconds = outboxRetryDelaySeconds(attempts, backoffBaseSeconds);
      const nextAvailableAt = new Date(Date.now() + delaySeconds * 1000);
      return await client
        .updateTable('outbox_commands')
        .set({
          state: 'pending',
          attempts,
          available_at: nextAvailableAt,
          last_error: error,
          leased_until: null,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
  }

  async findByAggregateId(
    tenantId: string,
    aggregateTypeOrId: string,
    aggregateIdOrTrx?: string | Kysely<Database>,
    trx?: Kysely<Database>
  ) {
    let aggregateType: string | undefined;
    let aggregateId: string;
    let clientTrx: Kysely<Database> | undefined;

    if (typeof aggregateIdOrTrx === 'string') {
      aggregateType = aggregateTypeOrId;
      aggregateId = aggregateIdOrTrx;
      clientTrx = trx;
    } else {
      aggregateId = aggregateTypeOrId;
      clientTrx = aggregateIdOrTrx as Kysely<Database> | undefined;
    }

    const client = clientTrx || this.db;
    let query = client
      .selectFrom('outbox_commands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('aggregate_id', '=', aggregateId);
    if (aggregateType) {
      query = query.where('aggregate_type', '=', aggregateType);
    }
    return await query.orderBy('created_at', 'desc').execute();
  }

  async findById(idOrTenantId: string, idOrTrx?: string | Kysely<Database>, trx?: Kysely<Database>) {
    let id: string;
    let tenantId: string | undefined;
    let clientTrx: Kysely<Database> | undefined;

    if (typeof idOrTrx === 'string') {
      tenantId = idOrTenantId;
      id = idOrTrx;
      clientTrx = trx;
    } else {
      id = idOrTenantId;
      clientTrx = idOrTrx as Kysely<Database> | undefined;
    }

    const client = clientTrx || this.db;
    let query = client.selectFrom('outbox_commands').selectAll().where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async markPermanentFailure(id: string, error: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .updateTable('outbox_commands')
      .set((eb) => ({
        state: 'failed',
        attempts: eb('attempts', '+', 1),
        last_error: error,
        leased_until: null,
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async markUncertain(id: string, error: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const prefix = error.startsWith('DELIVERY_UNCERTAIN:') ? error : `DELIVERY_UNCERTAIN: ${error}`;
    return await client
      .updateTable('outbox_commands')
      .set((eb) => ({
        state: 'failed',
        attempts: eb('attempts', '+', 1),
        last_error: prefix,
        leased_until: null,
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async redrive(idOrTenantId: string, idOrTrx?: string | Kysely<Database>, trx?: Kysely<Database>) {
    let id: string;
    let tenantId: string | undefined;
    let clientTrx: Kysely<Database> | undefined;

    if (typeof idOrTrx === 'string') {
      tenantId = idOrTenantId;
      id = idOrTrx;
      clientTrx = trx;
    } else {
      id = idOrTenantId;
      clientTrx = idOrTrx as Kysely<Database> | undefined;
    }

    const client = clientTrx || this.db;
    let query = client
      .updateTable('outbox_commands')
      .set({
        state: 'pending',
        attempts: 0,
        available_at: new Date(),
        last_error: null,
        leased_until: null,
      })
      .where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.returningAll().executeTakeFirstOrThrow();
  }

  /** Dead letters: commands that exhausted their retries, oldest first. They degrade worker health. */
  async listFailed(tenantId: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .selectFrom('outbox_commands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('state', '=', 'failed')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Retires a dead letter: 'failed' becomes 'dead', never retried or redriven again, with who
   * retired it and why prefixed to its last error. For a command that is obsolete (its request was
   * superseded or handled another way), not one that should still be delivered: that is `redrive`.
   * Returns undefined when the command is not in 'failed'.
   */
  async retire(tenantId: string, id: string, reason: string, actorId: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .updateTable('outbox_commands')
      .set((eb) => ({
        state: 'dead',
        leased_until: null,
        last_error: sql<string>`${`RETIRED by ${actorId} at ${new Date().toISOString()}: ${reason} | was: `} || coalesce(${eb.ref('last_error')}, '')`,
      }))
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .where('state', '=', 'failed')
      .returningAll()
      .executeTakeFirst();
  }
}

