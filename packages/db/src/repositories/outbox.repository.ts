import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export class OutboxRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async enqueue(tenantId: string, taskId: string | null, destination: string, payload: Record<string, unknown>) {
    return await this.db
      .insertInto('outbox')
      .values({
        tenant_id: tenantId,
        task_id: taskId,
        destination,
        payload,
        state: 'pending',
        attempts: 0,
        last_error: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async leasePending(limit: number = 10) {
    return await this.db
      .updateTable('outbox')
      .set({
        state: 'leased',
      })
      .where('state', '=', 'pending')
      .returningAll()
      .execute();
  }

  async markDelivered(id: string) {
    return await this.db
      .updateTable('outbox')
      .set({
        state: 'delivered',
        delivered_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  async markFailed(id: string, error: string) {
    return await this.db
      .updateTable('outbox')
      .set((eb) => ({
        state: 'failed',
        attempts: eb('attempts', '+', 1),
        last_error: error,
      }))
      .where('id', '=', id)
      .execute();
  }
}
