import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { CanvaBindingRepository } from '../src/repositories/canva-binding.repository.js';
import { createDb } from '../src/client.js';
import type { Database } from '../src/types.js';
import type { Kysely } from 'kysely';

const POSTGRES_PORT = process.env.POSTGRES_PORT || '54332';
const TEST_DB_URL = process.env.POSTGRES_LIVE_URL || `postgresql://hawa_owner:hawa_production_secure_pass@127.0.0.1:${POSTGRES_PORT}/hawa_test`;

describe('CanvaBindingRepository — Live Database Integration Suite (hawa_test)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let repo: CanvaBindingRepository;

  const testTenantId = '00000000-0000-4000-a000-000000000001';
  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002'; // KAAE from seed
  const fastpayClientId = 'c1000000-0000-4000-8000-000000000004'; // FastPay from seed
  const testTaskId = '99990000-0000-4000-9000-000000000001';
  const testDesignId = 'DAHU6ovIEc4';

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    pool.on('connect', (client) => {
      client.query('SET search_path TO hawa, public');
    });
    db = createDb(TEST_DB_URL);
    repo = new CanvaBindingRepository(db);

    // Clean up any stale test fixtures
    await pool.query(`DELETE FROM hawa.canva_capture_sets WHERE tenant_id = $1;`, [testTenantId]);
    await pool.query(`DELETE FROM hawa.canva_bindings WHERE tenant_id = $1;`, [testTenantId]);
    await pool.query(`DELETE FROM hawa.tasks WHERE id = $1;`, [testTaskId]);

    // Insert test task belonging to KAAE
    await pool.query(
      `INSERT INTO hawa.tasks (id, tenant_id, client_id, title, state)
       VALUES ($1, $2, $3, $4, 'received')
       ON CONFLICT (id) DO NOTHING;`,
      [testTaskId, testTenantId, kaaeClientId, 'KAAE Gala Invitation — CV-04 Integration Test']
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM hawa.canva_capture_sets WHERE tenant_id = $1;`, [testTenantId]);
      await pool.query(`DELETE FROM hawa.canva_bindings WHERE tenant_id = $1;`, [testTenantId]);
      await pool.query(`DELETE FROM hawa.tasks WHERE id = $1;`, [testTaskId]);
      await db.destroy();
      await pool.end();
    }
  });

  it('1. Successfully persists Canva binding into live PostgreSQL table hawa.canva_bindings', async () => {
    const binding = await repo.createBinding({
      tenantId: testTenantId,
      taskId: testTaskId,
      clientId: kaaeClientId,
      canvaDesignId: testDesignId,
      canvaTeamId: 'team_kaae_creative',
      editUrl: `https://www.canva.com/design/${testDesignId}/edit`,
      directionName: 'primary',
    });

    expect(binding).toBeDefined();
    expect(binding.canva_design_id).toBe(testDesignId);
    expect(binding.client_id).toBe(kaaeClientId);
    expect(binding.version).toBe(1);
    expect(binding.status).toBe('bound');

    // Verify raw query in PostgreSQL
    const res = await pool.query(
      `SELECT * FROM hawa.canva_bindings WHERE id = $1;`,
      [binding.id]
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].canva_design_id).toBe(testDesignId);
  });

  it('2. Enforces foreign client denial in live database: refuses capture if client ID is mismatched', async () => {
    const binding = await repo.findByTaskId(testTenantId, testTaskId);
    expect(binding).toBeDefined();

    await expect(
      repo.captureArtifactSet({
        tenantId: testTenantId,
        bindingId: binding!.id,
        taskId: testTaskId,
        clientId: fastpayClientId, // Foreign client
        canvaDesignId: testDesignId,
        expectedVersion: 1,
        capturedArtifactSetHash: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
        artifacts: [
          {
            format: 'png',
            storageKey: 'exports/kaae/test.png',
            sha256: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
            byteSize: 204800,
          },
        ],
        semanticCoverage: {
          textNodesCount: 5,
          imageFillsCount: 2,
          hasLogo: true,
          isComplete: true,
        },
        authActor: { actorType: 'user', actorId: 'usr_operator_hawzhin' },
      })
    ).rejects.toThrow('Foreign client denial');
  });

  it('3. Enforces optimistic concurrency in live database: refuses capture with stale version', async () => {
    const binding = await repo.findByTaskId(testTenantId, testTaskId);
    expect(binding).toBeDefined();

    await expect(
      repo.captureArtifactSet({
        tenantId: testTenantId,
        bindingId: binding!.id,
        taskId: testTaskId,
        clientId: kaaeClientId,
        canvaDesignId: testDesignId,
        expectedVersion: 99, // Stale version
        capturedArtifactSetHash: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
        artifacts: [
          {
            format: 'png',
            storageKey: 'exports/kaae/test.png',
            sha256: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
            byteSize: 204800,
          },
        ],
        semanticCoverage: {
          textNodesCount: 5,
          imageFillsCount: 2,
          hasLogo: true,
          isComplete: true,
        },
        authActor: { actorType: 'user', actorId: 'usr_operator_hawzhin' },
      })
    ).rejects.toThrow('Stale version conflict');
  });

  it('4. Enforces snapshot completeness invariant in live database: rejects incomplete observation', async () => {
    const binding = await repo.findByTaskId(testTenantId, testTaskId);
    expect(binding).toBeDefined();

    await expect(
      repo.captureArtifactSet({
        tenantId: testTenantId,
        bindingId: binding!.id,
        taskId: testTaskId,
        clientId: kaaeClientId,
        canvaDesignId: testDesignId,
        expectedVersion: 1,
        capturedArtifactSetHash: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
        artifacts: [
          {
            format: 'png',
            storageKey: 'exports/kaae/test.png',
            sha256: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
            byteSize: 204800,
          },
        ],
        semanticCoverage: {
          textNodesCount: 2,
          imageFillsCount: 0,
          hasLogo: false,
          isComplete: false, // Incomplete snapshot
        },
        authActor: { actorType: 'user', actorId: 'usr_operator_hawzhin' },
      })
    ).rejects.toThrow('Snapshot incompleteness denial');
  });

  it('5. Successfully records verified artifact capture set in PostgreSQL and increments binding version to 2', async () => {
    const binding = await repo.findByTaskId(testTenantId, testTaskId);
    expect(binding).toBeDefined();

    const captureSet = await repo.captureArtifactSet({
      tenantId: testTenantId,
      bindingId: binding!.id,
      taskId: testTaskId,
      clientId: kaaeClientId,
      canvaDesignId: testDesignId,
      expectedVersion: 1,
      capturedArtifactSetHash: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
      artifacts: [
        {
          format: 'pdf_print',
          storageKey: 'exports/kaae/invitation_print_cmyk.pdf',
          sha256: 'b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f',
          byteSize: 1048576,
          colorSpace: 'cmyk',
          dpi: 300,
        },
        {
          format: 'png',
          storageKey: 'exports/kaae/invitation_digital.png',
          sha256: 'c6c95e0546c911470b9f5d5d2b6c9f3d70c02f0f2b3c4d5e6f7a8b9c0d1e2f3a',
          byteSize: 524288,
          colorSpace: 'srgb',
        },
      ],
      exportSettings: {
        print: true,
        cmyk: true,
        bleed: true,
        cropMarks: true,
      },
      semanticCoverage: {
        textNodesCount: 5,
        imageFillsCount: 2,
        hasLogo: true,
        isComplete: true,
      },
      authActor: { actorType: 'user', actorId: 'usr_operator_hawzhin' },
    });

    expect(captureSet).toBeDefined();
    expect(captureSet.version).toBe(2);

    // Verify updated binding version in PostgreSQL
    const updatedBinding = await repo.findById(binding!.id);
    expect(updatedBinding!.version).toBe(2);

    // Verify capture set is listable
    const sets = await repo.listCaptureSetsForTask(testTenantId, testTaskId);
    expect(sets.length).toBe(1);
    expect(sets[0].captured_artifact_set_hash).toBe('b5b84d9435b800369a8f4c4c1a5b8f2c69b91e9f1a2b3c4d5e6f7a8b9c0d1e2f');
  });
});
