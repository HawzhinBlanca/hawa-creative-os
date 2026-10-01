import {createApp as boundaryCore} from '../src/app.js';
import {persistClientDnaFixture,clientDnaFixture} from './fixtures/persisted-client-dna.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { CostGovernor } from '@hawa/integrations';
import { createDb, ClientRepository, withRlsContext } from '@hawa/db';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('R03: Authoritative Configuration and Policies in PostgreSQL (FR-017, FR-054, FR-069, FR-078, FR-079)', () => {
  const originalEnv = { ...process.env };
  const testToken = 'r03-op-auth';
  const headers = {
    Authorization: `Bearer ${testToken}`,
    'Content-Type': 'application/json',
    'x-enforce-auth': '1',
  };

  beforeAll(() => {
    process.env.HAWA_BEARER_TOKEN = testToken;
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. Process/Instance Recreation Preserves Authoritative State', () => {
    it('preserves client DNA mutations and version increment across new createAppWithClientFixtures() instances', async () => {
      const app1 = createAppWithClientFixtures();
      await persistClientDnaFixture(app1,'c1000000-0000-4000-8000-000000000003',headers);
      const getOriginal = await app1.request('/v1/clients/client-drustee/dna', { headers });
      expect(getOriginal.status).toBe(200);
      const originalDna = await getOriginal.json();

      const updatedName = `Drustee Mutated At ${Date.now()}`;
      const updateRes = await app1.request('/v1/clients/client-drustee/dna', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...originalDna,
          name: updatedName,
        }),
      });
      expect(updateRes.status).toBe(201);
      const updatedDna = await updateRes.json();
      expect(updatedDna.name).toBe(updatedName);
      expect(updatedDna.version).toBe(originalDna.version + 1);

      // Recreate app instance (simulating worker restart or second instance)
      const app2 = createAppWithClientFixtures();
      const getRecreated = await app2.request('/v1/clients/client-drustee/dna', { headers });
      expect(getRecreated.status).toBe(200);
      const recreatedDna = await getRecreated.json();

      expect(recreatedDna.name).toBe(updatedName);
      expect(recreatedDna.version).toBe(updatedDna.version);
    });
  });

  describe('2. Forged createdBy Ignored / Rejected', () => {
    it('ignores client-supplied createdBy and attributes snapshot to authenticated identity', async () => {
      const app = createAppWithClientFixtures();
      const getOriginal = await app.request('/v1/clients/client-drustee/dna', { headers });
      const originalDna = await getOriginal.json();

      const forgedAuthor = 'unauthorized_attacker_spoofed_author';
      const postRes = await app.request('/v1/clients/client-drustee/dna', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...originalDna,
          name: 'Drustee Anti-Spoofing Test',
          createdBy: forgedAuthor,
        }),
      });
      expect(postRes.status).toBe(201);

      const snapshotsRes = await app.request('/v1/clients/client-drustee/snapshots', { headers });
      expect(snapshotsRes.status).toBe(200);
      const snapshots = await snapshotsRes.json();
      expect(snapshots.length).toBeGreaterThan(0);
      const latest = snapshots[0];

      // Must be authenticated actor, NOT the forged author
      expect(latest.createdBy).not.toBe(forgedAuthor);
      expect(latest.createdBy).toBe('operator_1');
    });
  });

  describe('3. Optimistic Concurrency with expectedVersion', () => {
    it('yields one winner and one 409 conflict on two competing expected-version updates', async () => {
      const app = createAppWithClientFixtures();
      const getOriginal = await app.request('/v1/clients/client-drustee/dna', { headers });
      const originalDna = await getOriginal.json();
      const baseVersion = originalDna.version;

      // Update 1 specifies expectedVersion matching current version
      const update1Promise = app.request('/v1/clients/client-drustee/dna', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...originalDna,
          name: 'Competing Update 1',
          expectedVersion: baseVersion,
        }),
      });

      // Competing Update 2 also specifies expectedVersion matching old baseVersion
      const update2Promise = app.request('/v1/clients/client-drustee/dna', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...originalDna,
          name: 'Competing Update 2',
          expectedVersion: baseVersion,
        }),
      });

      const [res1, res2] = await Promise.all([update1Promise, update2Promise]);
      const statuses = [res1.status, res2.status].sort();

      // One must succeed (201) and one must conflict (409)
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('4. Failed Database Transaction Leaves No Success Response / Mutation', () => {
    it('holds an unreadable database without mutating the process cache', async () => {
      // Mock repository that rejects all writes
      const failingDb = {
        transaction: () => ({
          execute: async () => {
            throw new Error('Injected Database Disk Failure');
          },
        }),
      } as any;

      const originalDna = clientDnaFixture('client-drustee');
      let cache:ReadonlyMap<string,unknown>|undefined;
      const app = boundaryCore({db:failingDb,seedClientDna:map=>{
        map.set('client-drustee',structuredClone(originalDna));cache=map;
      }});
      expect((await app.request('/v1/clients/client-drustee/dna',{headers})).status).toBe(503);

      const postRes = await app.request('/v1/clients/client-drustee/dna', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...originalDna,
          name: 'This Mutation Must Fail',
        }),
      });

      // Must NOT be 201
      expect(postRes.status).toBe(503);

      // In-memory state must NOT have updated
      const getAfter = await app.request('/v1/clients/client-drustee/dna', { headers });
      expect(getAfter.status).toBe(503);
      expect(cache?.get('client-drustee')).toEqual(originalDna);
    });
  });

  describe('5. Spend Cap Enforcement & Concurrency Protection (FR-079)', () => {
    it('prevents concurrent spending reservations from exceeding the configured cap', async () => {
      const governor = new CostGovernor();
      const clientId = 'client-spend-test';
      governor.allocateBudget(clientId, 10.0); // $10 cap

      // Fire two concurrent reservations of $6.0 each (total $12.0 > $10.0 cap)
      const [res1, res2] = await Promise.all([
        Promise.resolve(governor.reserveBudget({ clientId, amountUsd: 6.0 })),
        Promise.resolve(governor.reserveBudget({ clientId, amountUsd: 6.0 })),
      ]);

      const allowedCount = [res1.allowed, res2.allowed].filter(Boolean).length;
      expect(allowedCount).toBe(1); // Exactly one allowed

      const activeReserved = governor.getActiveReservationUsd(clientId);
      expect(activeReserved).toBe(6.0);
      expect(activeReserved).toBeLessThanOrEqual(10.0);
    });

    it('persists budgets and allocations across restarts via export and hydration', () => {
      const tmpFile = path.join(os.tmpdir(), `hawa-budgets-${Date.now()}.json`);
      try {
        const gov1 = new CostGovernor({ storagePath: tmpFile });
        gov1.allocateBudget('client-drustee', 55.0);
        gov1.recordUsage({
          clientId: 'client-drustee',
          taskId: 'task-1',
          role: 'layout',
          provider: 'openai',
          model: 'gpt-4o',
          inputTokens: 1000,
          outputTokens: 500,
          gpuSeconds: 0,
        });

        const state = gov1.exportState();
        expect(fs.existsSync(tmpFile)).toBe(true);

        // Restart with fresh governor instance pointing to same file
        const gov2 = new CostGovernor({ storagePath: tmpFile });
        const budget = gov2.getOrCreateClientBudget('client-drustee');
        expect(budget.capUsd).toBe(55.0);
        expect(budget.spentUsd).toBeGreaterThan(0);
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });
  });

  describe('6. Real PostgreSQL Client DNA Persistence (Isolated Test DB)', () => {
    const testDbUrl = process.env.TEST_DATABASE_URL!;

    it('persists DNA version to hawa.client_dna_versions table with expected version checks', async () => {
      let db: any;
      try {
        db = createDb(testDbUrl);
        const clientRepo = new ClientRepository(db);

        const tenantId = '00000000-0000-4000-a000-000000000001';
        const clientId = 'c1000000-0000-4000-8000-000000000002'; // KAAE UUID
        const adminUserId = '00000000-0000-4000-b000-000000000002';

        await withRlsContext(db, { tenantId, clientId, userId: adminUserId, role: 'administrator' }, async (trx) => {
          await (trx as any).deleteFrom('hawa.client_dna_versions').where('client_id', '=', clientId).execute();

          const v1 = await clientRepo.saveDnaVersion({
            tenantId,
            clientId,
            version: 1,
            dna: { name: 'KAAE Real DB Test v1', code: 'KAAE' },
            contentHash: 'hash-kaae-v1',
            expectedVersion: 0,
          }, trx);
          expect(v1.version).toBe(1);
          expect(v1.status).toBe('active');

          // Optimistic concurrency conflict when expecting outdated version
          await expect(
            clientRepo.saveDnaVersion({
              tenantId,
              clientId,
              version: 2,
              dna: { name: 'KAAE Conflict Test', code: 'KAAE' },
              contentHash: 'hash-kaae-v2',
              expectedVersion: 0, // Expected 0, but current is 1
            }, trx)
          ).rejects.toThrow(/OptimisticConcurrencyConflict/);

          // Valid update expecting current version 1
          const v2 = await clientRepo.saveDnaVersion({
            tenantId,
            clientId,
            version: 2,
            dna: { name: 'KAAE Real DB Test v2', code: 'KAAE' },
            contentHash: 'hash-kaae-v2',
            expectedVersion: 1,
          }, trx);
          expect(v2.version).toBe(2);
          expect(v2.status).toBe('active');

          // Previous version 1 must now be superseded
          const previous = await clientRepo.findDnaByVersion(tenantId, clientId, 1, trx);
          expect(previous?.status).toBe('superseded');

          // Active version must be 2
          const active = await clientRepo.findActiveDna(tenantId, clientId, trx);
          expect(active?.version).toBe(2);

          // Clean up test versions so subsequent tests have pristine state
          await (trx as any).deleteFrom('hawa.client_dna_versions').where('client_id', '=', clientId).execute();
        });
      } catch (err: any) {
        // If Postgres is unreachable in pure CI environment without container, skip
        if (err.message && err.message.includes('ECONNREFUSED')) {
          console.warn('Postgres not available, skipping live DB test');
          return;
        }
        throw err;
      } finally {
        if (db) await db.destroy();
      }
    });
  });
});
