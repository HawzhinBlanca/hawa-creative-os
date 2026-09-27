import { describe, it, expect } from 'vitest';
import {
  TaskRepository,
  IngressRepository,
  OutboxRepository,
} from '../src/index.js';

function createMockDb() {
  const store = {
    tasks: [] as any[],
    task_events: [] as any[],
    raw_ingress_events: [] as any[],
    outbox: [] as any[],
    outbox_commands: [] as any[],
  };

  const createQueryBuilder = (table: keyof typeof store) => {
    let whereClauses: Array<{ col: string; op: string; val: any }> = [];
    let valuesToInsert: any = null;
    let valuesToSet: any = null;
    let limitCount: number | null = null;

    const builder: any = {
      selectAll: () => builder,
      select: () => builder,
      returningAll: () => builder,
      returning: () => builder,
      where: (col: any, op?: string, val?: any) => {
        if (typeof col === 'function') {
          whereClauses.push({ col: 'state', op: '=', val: 'pending' });
        } else {
          whereClauses.push({ col, op: op!, val });
        }
        return builder;
      },
      values: (val: any) => {
        valuesToInsert = val;
        return builder;
      },
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      set: (val: any) => {
        valuesToSet = val;
        return builder;
      },
      executeTakeFirst: async () => {
        if (valuesToSet) {
          const row = store[table].find((r) => whereClauses.every((w) => r[w.col] === w.val));
          if (row) {
            Object.assign(row, valuesToSet);
            return row;
          }
          return null;
        }
        const list = store[table].filter((row) => {
          return whereClauses.every((w) => {
            if (w.op === 'in' && Array.isArray(w.val)) {
              return w.val.includes(row[w.col]);
            }
            return row[w.col] === w.val;
          });
        });
        return list[0] || null;
      },
      executeTakeFirstOrThrow: async () => {
        if (valuesToInsert) {
          const newRow = { id: crypto.randomUUID(), ...valuesToInsert };
          store[table].push(newRow);
          return newRow;
        }
        if (valuesToSet) {
          const row = store[table].find((r) => whereClauses.every((w) => r[w.col] === w.val));
          if (row) {
            Object.assign(row, valuesToSet);
            return row;
          }
        }
        const res = await builder.executeTakeFirst();
        if (!res) throw new Error('Not found');
        return res;
      },
      execute: async () => {
        const matchWhere = (row: any) => {
          return whereClauses.every((w) => {
            if (w.op === 'in' && Array.isArray(w.val)) {
              return w.val.includes(row[w.col]);
            }
            return row[w.col] === w.val;
          });
        };
        if (valuesToSet) {
          const updated = store[table].filter(matchWhere);
          for (const row of updated) {
            Object.assign(row, valuesToSet);
          }
          return updated;
        }
        if (valuesToInsert) {
          const newRow = { id: crypto.randomUUID(), ...valuesToInsert };
          store[table].push(newRow);
          return [newRow];
        }
        let list = store[table].filter(matchWhere);
        if (limitCount !== null) {
          list = list.slice(0, limitCount);
        }
        return list;
      },
    };
    return builder;
  };

  const db: any = {
    selectFrom: (table: keyof typeof store) => createQueryBuilder(table),
    insertInto: (table: keyof typeof store) => createQueryBuilder(table),
    updateTable: (table: keyof typeof store) => createQueryBuilder(table),
    transaction: () => ({
      execute: async (callback: any) => await callback(db),
    }),
  };

  return { db, store };
}

describe('DB Repositories: Isolation & Audit Trail', () => {
  it('TaskRepository: creates task, locks client scope, and updates status with immutable audit events', async () => {
    const { db, store } = createMockDb();
    const taskRepo = new TaskRepository(db);

    const res = await taskRepo.create({
      tenantId: 'tenant-db-1',
      clientId: 'client-db-1',
      sourcePlatform: 'telegram',
      sourceEventId: 'evt-100',
      sourceChannelId: 'chan-100',
      idempotencyKey: 'idem-db-1',
      priority: 'routine',
    });

    expect(res.task.id).toBeDefined();
    expect(res.task.status).toBe('RECEIVED');
    expect(res.created).toBe(true);

    // Lock client scope
    const lockedTask = await taskRepo.lockClientScope(res.task.id, 'client-db-1');
    expect(lockedTask.client_scope_locked).toBe(true);

    // Re-locking to the same client is idempotent
    const relockedTask = await taskRepo.lockClientScope(res.task.id, 'client-db-1');
    expect(relockedTask.client_scope_locked).toBe(true);

    // Attempting to rebind to a foreign client is rejected by immutability invariant
    await expect(taskRepo.lockClientScope(res.task.id, 'client-db-2')).rejects.toThrow('Client scope is immutable');

    // Update status to BRIEFING
    const updated = await taskRepo.updateStatus(
      res.task.id,
      'RECEIVED',
      'BRIEFING',
      'worker-1',
      'workflow',
      'Locked client scope'
    );
    expect(updated.status).toBe('BRIEFING');
    expect(store.task_events.length).toBe(2);

    // Invalid fromStatus transition fails with ConcurrencyConflictError
    await expect(
      taskRepo.updateStatus(
        res.task.id,
        'COMPOSING', // Task is in BRIEFING (brief_draft), not COMPOSING (studio_composition)
        'AWAITING_APPROVAL',
        'worker-1',
        'workflow',
        'Illegal state transition attempt'
      )
    ).rejects.toThrow();
  });

  it('IngressRepository: detects and deduplicates duplicate raw events', async () => {
    const { db } = createMockDb();
    const ingressRepo = new IngressRepository(db);

    const res1 = await ingressRepo.recordEvent({
      adapterKind: 'telegram',
      sourceEventId: 'tg-dup-99',
      payloadHash: 'hash-dup-99',
      headers: { 'x-secret': 'valid' },
      body: { update_id: 99 },
      verified: true,
    });
    expect(res1.isDuplicate).toBe(false);

    const res2 = await ingressRepo.recordEvent({
      adapterKind: 'telegram',
      sourceEventId: 'tg-dup-99',
      payloadHash: 'hash-dup-99',
      headers: { 'x-secret': 'valid' },
      body: { update_id: 99 },
      verified: true,
    });
    expect(res2.isDuplicate).toBe(true);
  });

  it('OutboxRepository: enqueues, leases, and delivers events', async () => {
    const { db } = createMockDb();
    const outbox = new OutboxRepository(db);

    const outboxRow = await outbox.enqueue(
      'tenant-db-1',
      'task-1',
      'restate:workflow',
      { action: 'start' }
    );

    expect(outboxRow.id).toBeDefined();
    const leased = await outbox.leasePending(5);
    expect(leased.length).toBe(1);

    await outbox.markDelivered(outboxRow.id);
    expect(outboxRow.state).toBe('delivered');
  });

  it('Schema Migration: parses all 57 tables, enums, triggers, and runs dry-run migration', async () => {
    const { runMigrations, parseSchemaSql } = await import('../src/migrate.js');
    const result = await runMigrations({ dryRun: true });

    expect(result.success).toBe(true);
    expect(result.tableCount).toBe(57);
    expect(result.statementCount).toBeGreaterThan(50);
  });
});
