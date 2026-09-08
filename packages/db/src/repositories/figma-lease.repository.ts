import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export interface AcquireFigmaLeaseParams {
  taskId: string;
  clientId: string;
  figmaFileKey: string;
  holder: string;
  ttlSeconds: number;
}

export class FigmaLeaseRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async getActiveLease(taskId: string) {
    const now = new Date();
    return await this.db
      .selectFrom('figma_leases')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('released_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
  }

  async acquireLease(params: AcquireFigmaLeaseParams) {
    const active = await this.getActiveLease(params.taskId);
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

    if (active) {
      if (active.holder === params.holder) {
        // Renew lease
        return await this.db
          .updateTable('figma_leases')
          .set({ expires_at: expiresAt })
          .where('id', '=', active.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      throw new Error(`Task ${params.taskId} already has an active Figma lease held by ${active.holder}`);
    }

    return await this.db
      .insertInto('figma_leases')
      .values({
        task_id: params.taskId,
        client_id: params.clientId,
        figma_file_key: params.figmaFileKey,
        holder: params.holder,
        expires_at: expiresAt,
        released_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async releaseLease(leaseId: string) {
    return await this.db
      .updateTable('figma_leases')
      .set({ released_at: new Date() })
      .where('id', '=', leaseId)
      .returningAll()
      .executeTakeFirst();
  }
}
