import { describe, it, expect } from 'vitest';
import { CanvaBindingRepository } from '../src/repositories/canva-binding.repository.js';

function createMockDb() {
  const store = {
    tasks: [] as any[],
    canva_bindings: [] as any[],
    canva_capture_sets: [] as any[],
  };

  const createQueryBuilder = (table: keyof typeof store) => {
    let whereClauses: Array<{ col: string; op: string; val: any }> = [];
    let valuesToInsert: any = null;
    let valuesToSet: any = null;
    let selectedCols: string[] | null = null;

    const builder: any = {
      selectAll: () => builder,
      onConflict: () => builder,
      forUpdate: () => builder,
      returningAll: () => builder,
      returning: () => builder,
      select: (cols: string[]) => {
        selectedCols = cols;
        return builder;
      },
      where: (col: any, op?: string, val?: any) => {
        whereClauses.push({ col, op: op!, val });
        return builder;
      },
      values: (val: any) => {
        valuesToInsert = val;
        return builder;
      },
      set: (val: any) => {
        valuesToSet = val;
        return builder;
      },
      orderBy: () => builder,
      executeTakeFirst: async () => {
        if (valuesToInsert) {
          if (table === 'canva_bindings' && store.canva_bindings.some(row => row.canva_design_id === valuesToInsert.canva_design_id)) return undefined;
          const newRow = { id: crypto.randomUUID(), created_at: new Date(), ...valuesToInsert };
          store[table].push(newRow);
          return newRow;
        }
        const list = store[table].filter((row) => {
          return whereClauses.every((w) => row[w.col] === w.val);
        });
        return list[0] || null;
      },
      executeTakeFirstOrThrow: async () => {
        if (valuesToInsert) {
          const newRow = { id: crypto.randomUUID(), created_at: new Date(), updated_at: new Date(), ...valuesToInsert };
          store[table].push(newRow);
          return newRow;
        }
        const res = await builder.executeTakeFirst();
        if (!res) throw new Error('Not found');
        return res;
      },
      execute: async () => {
        const matchWhere = (row: any) => whereClauses.every((w) => row[w.col] === w.val);
        if (valuesToSet) {
          const updated = store[table].filter(matchWhere);
          for (const row of updated) {
            Object.assign(row, valuesToSet);
          }
          return updated;
        }
        if (valuesToInsert) {
          const newRow = { id: crypto.randomUUID(), created_at: new Date(), ...valuesToInsert };
          store[table].push(newRow);
          return [newRow];
        }
        return store[table].filter(matchWhere);
      },
    };
    return builder;
  };

  const db: any = {
    isTransaction: true,
    selectFrom: (table: keyof typeof store) => createQueryBuilder(table),
    insertInto: (table: keyof typeof store) => createQueryBuilder(table),
    updateTable: (table: keyof typeof store) => createQueryBuilder(table),
  };

  return { db, store };
}

describe('CanvaBindingRepository — Server-Derived Ownership & Invariants (CV-04)', () => {
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const clientIdA = 'c1000000-0000-4000-8000-000000000002'; // KAAE
  const clientIdB = 'c1000000-0000-4000-8000-000000000004'; // FastPay
  const taskId = 't1000000-0000-4000-9000-000000000001';
  const designId = 'DAHU6ovIEc4';

  it('proves server-derived ownership: creates binding when task exists and belongs to client', async () => {
    const { db, store } = createMockDb();
    // Pre-populate task belonging to Client A
    store.tasks.push({
      id: taskId,
      tenant_id: tenantId,
      client_id: clientIdA,
      title: 'KAAE Gala Poster',
    });

    const repo = new CanvaBindingRepository(db);
    const binding = await repo.createBinding({
      tenantId,
      taskId,
      clientId: clientIdA,
      canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit`,
    });

    expect(binding).toBeDefined();
    expect(binding.canva_design_id).toBe(designId);
    expect(binding.client_id).toBe(clientIdA);
    expect(binding.version).toBe(1);
    expect(binding.status).toBe('bound');
  });

  it('denies cross-client binding: fails if requested client does not match task client', async () => {
    const { db, store } = createMockDb();
    store.tasks.push({
      id: taskId,
      tenant_id: tenantId,
      client_id: clientIdA, // Task belongs to Client A
      title: 'KAAE Gala Poster',
    });

    const repo = new CanvaBindingRepository(db);

    // Client B attempts to bind Client A's task
    await expect(
      repo.createBinding({
        tenantId,
        taskId,
        clientId: clientIdB,
        canvaDesignId: designId,
        editUrl: `https://www.canva.com/design/${designId}/edit`,
      })
    ).rejects.toThrow('Server-derived ownership denial');
  });

  it('denies binding a design already bound to a foreign client', async () => {
    const { db, store } = createMockDb();
    const task2 = 't1000000-0000-4000-9000-000000000002';
    store.tasks.push({ id: taskId, tenant_id: tenantId, client_id: clientIdA });
    store.tasks.push({ id: task2, tenant_id: tenantId, client_id: clientIdB });

    const repo = new CanvaBindingRepository(db);
    // Bind design to Client A first
    await repo.createBinding({
      tenantId,
      taskId,
      clientId: clientIdA,
      canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit`,
    });

    // Now Client B attempts to bind the same design
    await expect(
      repo.createBinding({
        tenantId,
        taskId: task2,
        clientId: clientIdB,
        canvaDesignId: designId,
        editUrl: `https://www.canva.com/design/${designId}/edit`,
      })
    ).rejects.toThrow('binding conflict');
  });

  it('captureArtifactSet: enforces client match, design ID match, optimistic locking, and snapshot completeness', async () => {
    const { db, store } = createMockDb();
    store.tasks.push({ id: taskId, tenant_id: tenantId, client_id: clientIdA });
    const repo = new CanvaBindingRepository(db);

    const binding = await repo.createBinding({
      tenantId,
      taskId,
      clientId: clientIdA,
      canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit`,
    });

    const baseCaptureParams = {
      tenantId,
      bindingId: binding.id,
      taskId,
      clientId: clientIdA,
      canvaDesignId: designId,
      expectedVersion: 1,
      capturedArtifactSetHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      artifacts: [
        {
          format: 'pdf_print' as const,
          storageKey: 'exports/kaae/print.pdf',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          byteSize: 102400,
        },
      ],
      semanticCoverage: {
        textNodesCount: 5,
        imageFillsCount: 2,
        hasLogo: true,
        isComplete: true,
      },
      authActor: {
        actorType: 'user' as const,
        actorId: 'usr_test_operator',
      },
    };

    // 1. Foreign client denial
    await expect(
      repo.captureArtifactSet({
        ...baseCaptureParams,
        clientId: clientIdB, // Foreign client ID
      })
    ).rejects.toThrow('scope mismatch');

    // 2. Design ID mismatch denial
    await expect(
      repo.captureArtifactSet({
        ...baseCaptureParams,
        canvaDesignId: 'DAHX_DIFFERENT_DESIGN',
      })
    ).rejects.toThrow('scope mismatch');

    // 3. Stale version rejection
    await expect(
      repo.captureArtifactSet({
        ...baseCaptureParams,
        expectedVersion: 999, // Stale version
      })
    ).rejects.toThrow('Stale version conflict');

    // 4. Snapshot incompleteness denial
    await expect(
      repo.captureArtifactSet({
        ...baseCaptureParams,
        semanticCoverage: {
          textNodesCount: 1,
          imageFillsCount: 0,
          hasLogo: false,
          isComplete: false, // Incomplete snapshot
        },
      })
    ).rejects.toThrow('Incomplete semantic capture');

    // 5. Successful capture: bumps version to 2 and records artifact set
    const captureRecord = await repo.captureArtifactSet(baseCaptureParams);
    expect(captureRecord).toBeDefined();
    expect(captureRecord.version).toBe(2);

    // Verify binding version was incremented in store
    const updatedBinding = await repo.findById(binding.id);
    expect(updatedBinding?.version).toBe(2);

    // Verify subsequent capture requires expectedVersion = 2
    await expect(
      repo.captureArtifactSet({
        ...baseCaptureParams,
        expectedVersion: 1, // Now stale!
      })
    ).rejects.toThrow('Stale version conflict');

    // Successful second capture with version 2
    const secondCapture = await repo.captureArtifactSet({
      ...baseCaptureParams,
      expectedVersion: 2,
    });
    expect(secondCapture.version).toBe(3);
  });
});
