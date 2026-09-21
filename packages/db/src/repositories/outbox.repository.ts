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

export class OutboxRepository {
  constructor(private readonly db: Kysely<Database>) {}

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

  async leasePending(limit: number = 10, leaseSeconds: number = 60, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

    if (typeof (client as any).executeQuery === 'function') {
      const result = await sql<any>`
        WITH to_lease AS (
          SELECT id FROM outbox_commands
          WHERE ((state = 'pending') OR (state = 'leased' AND leased_until < ${now}))
            AND (available_at IS NULL OR available_at <= ${now})
          ORDER BY available_at ASC, created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_commands
        SET state = 'leased', leased_until = ${leaseUntil}
        WHERE id IN (SELECT id FROM to_lease)
        RETURNING *
      `.execute(client);

      return result.rows || [];
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

