import { describe, it, expect, afterAll } from 'vitest';
import type { Database, Kysely } from '@hawa/db';
import {clientDnaFixture} from './fixtures/persisted-client-dna.js';
import { createQueryOnlyDb } from '../../../packages/db/test-support/query-only-db.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { DesignStudioService, type Scope } from '../src/services/design-studio/design-studio-service.js';
import { CanvaFlowError } from '../src/services/canva-connect-service.js';

describe('R04: Enforce Principal, Tenant, Client, Task, and Run Scope Everywhere (FR-011, FR-043, FR-066-069, FR-077, NFR-006, NFR-007)', () => {
  const defaultTenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const adminUserId = '00000000-0000-4000-b000-000000000002';
  const staticAdminKey = process.env.HAWA_ADMIN_KEY || 'hawa_admin_dev';

  describe('1. Long-Lived Static Bearer Keys Forbidden in URL Query Parameters', () => {
    it('rejects static admin or operator bearer tokens passed via access_token query param', async () => {
      const app = createAppWithClientFixtures();

      // Attempting to pass static admin key as query param
      const res = await app.request(`/v1/events/stream?access_token=${encodeURIComponent(staticAdminKey)}`);
      expect(res.status).toBe(401);
    });

    // ADR-037 (2026-09-24): the session token no longer goes in the stream's address either; the Desk
    // opens the stream with a one-use ticket (test/stream-ticket.test.ts).
    it('refuses even an issued desk session in the access_token query param, and opens the stream with a ticket', async () => {
      const app = createAppWithClientFixtures();

      // Create an issued session via login
      const loginRes = await app.request('/v1/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'hawa_dev_token',
          role: 'operator',
          displayName: 'Test Session Operator',
        }),
      });
      expect(loginRes.status).toBe(201);
      const session = await loginRes.json();
      expect(session.token).toBeDefined();

      // The issued session token in the address is refused.
      const refused = await app.request(`/v1/events/stream?access_token=${encodeURIComponent(session.token)}`);
      expect(refused.status).toBe(401);

      // A ticket asked for with the session's bearer header opens it.
      const issued = await app.request('/v1/auth/stream-ticket', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } });
      const { ticket } = await issued.json();
      const streamRes = await app.request(`/v1/events/stream?ticket=${encodeURIComponent(ticket)}`);
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
      await streamRes.body?.cancel();
    });

    it('rejects unauthenticated requests to /events/stream', async () => {
      const app = createAppWithClientFixtures();
      const res = await app.request('/v1/events/stream', {
        headers: { 'x-enforce-auth': '1' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('2. DesignStudio Task and Actor Scope Enforcement', () => {
    const mockRepo = {
      getRunById: async (runId: string, tenantId: string) => {
        if (runId === 'run-1') {
          return {
            id: 'run-1',
            tenant_id: tenantId,
            task_id: 'task-owner-1',
            actor_id: 'user-designer-1',
            status: 'briefing',
            budget: { maxUsd: 5.0, maxCalls: 30, spentUsd: 0, calls: 0 },
            stages: {},
          };
        }
        return null;
      },
      updateRunStatus: async () => {},
      getCandidatesForRun: async () => [{ id: 'cand-1' }],
    };

    const service = Object.create(DesignStudioService.prototype);
    service.repo = mockRepo;
    // Compile the admission lock through Kysely without connecting to a database.
    // Real lock ordering is exercised in design-studio.test.ts, not this authorization fixture.
    const queryDb = createQueryOnlyDb();
    afterAll(() => queryDb.destroy());
    service.tx = async (_scope: unknown, fn: (db: Kysely<Database>) => unknown) => fn(queryDb);

    it('rejects abandon when supplied taskId does not match the run task_id', async () => {
      const scope: Scope = { tenantId: defaultTenantId, actorId: 'user-designer-1', role: 'operator' };

      await expect(
        service.abandon(scope, 'wrong-task-id', 'run-1', 'Test cancellation')
      ).rejects.toThrow(CanvaFlowError);

      try {
        await service.abandon(scope, 'wrong-task-id', 'run-1', 'Test cancellation');
      } catch (err: any) {
        expect(err.code).toBe('TASK_SCOPE_MISMATCH');
        expect(err.status).toBe(403);
      }
    });

    it('rejects abandon when actorId is different and not an administrator or art_director', async () => {
      const scope: Scope = { tenantId: defaultTenantId, actorId: 'unauthorized-stranger', role: 'operator' };

      try {
        await service.abandon(scope, 'task-owner-1', 'run-1', 'Malicious cancellation');
        expect.fail('Should have thrown ACTOR_SCOPE_MISMATCH');
      } catch (err: any) {
        expect(err.code).toBe('ACTOR_SCOPE_MISMATCH');
        expect(err.status).toBe(403);
      }
    });

    it('allows abandon by the initiating actor', async () => {
      const scope: Scope = { tenantId: defaultTenantId, actorId: 'user-designer-1', role: 'operator' };
      const res = await service.abandon(scope, 'task-owner-1', 'run-1', 'Legitimate cancellation');
      expect(res.status).toBe('abandoned');
    });

    it('allows abandon by an administrator', async () => {
      const scope: Scope = { tenantId: defaultTenantId, actorId: 'admin-override', role: 'administrator' };
      const res = await service.abandon(scope, 'task-owner-1', 'run-1', 'Admin supervisory cancellation');
      expect(res.status).toBe('abandoned');
    });

    it('allows abandon by an art_director', async () => {
      const scope: Scope = { tenantId: defaultTenantId, actorId: 'art-director-override', role: 'art_director' };
      const res = await service.abandon(scope, 'task-owner-1', 'run-1', 'Art director supervisory cancellation');
      expect(res.status).toBe('abandoned');
    });

    it('rejects selectCandidate when supplied taskId does not match run task_id', async () => {
      const scope: Scope = { tenantId: defaultTenantId, actorId: 'user-designer-1', role: 'operator' };
      try {
        await service.selectCandidate(scope, 'wrong-task-id', 'run-1', 'cand-1');
        expect.fail('Should have thrown TASK_SCOPE_MISMATCH');
      } catch (err: any) {
        expect(err.code).toBe('TASK_SCOPE_MISMATCH');
        expect(err.status).toBe(403);
      }
    });
  });

  describe('3. Session Revocation (Immediate Effect)', () => {
    it('revokes active session immediately so subsequent requests are rejected', async () => {
      const app = createAppWithClientFixtures();

      // 1. Issue session
      const loginRes = await app.request('/v1/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'hawa_dev_token', role: 'operator', displayName: 'Revocable User' }),
      });
      expect(loginRes.status).toBe(201);
      const session = await loginRes.json();
      const tokenHeader = { Authorization: `Bearer ${session.token}`, 'x-enforce-auth': '1' };

      // 2. Verified active
      const getRes1 = await app.request('/v1/clients/client-drustee/dna', { headers: tokenHeader });
      expect(getRes1.status).toBe(200);

      // 3. Revoke session
      const deleteRes = await app.request('/v1/auth/session', {
        method: 'DELETE',
        headers: tokenHeader,
      });
      expect(deleteRes.status).toBe(200);

      // 4. Subsequent request must be rejected (401)
      const getRes2 = await app.request('/v1/clients/client-drustee/dna', { headers: tokenHeader });
      expect(getRes2.status).toBe(401);
    });
  });

  describe('4. Governance and Scope Enforcement (SA-01 to SA-05)', () => {
    it('SA-01: rejects operator claiming administrator role via request body in DNA rollback', async () => {
      const app = createAppWithClientFixtures();
      const headers = {
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'hawa_dev_token'}`,
        'Content-Type': 'application/json',
        'x-enforce-auth': '1',
      };
      const res = await app.request('/v1/clients/client-drustee/dna/rollback', {
        method: 'POST',
        headers,
        body: JSON.stringify({ targetVersion: 1, role: 'administrator', reason: 'Role escalation probe' }),
      });
      expect(res.status).toBe(403);
    });

    it('SA-02: rejects cross-client candidate rule promotion', async () => {
      const app = createAppWithClientFixtures();
      const operatorHeaders = {
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'hawa_dev_token'}`,
        'Content-Type': 'application/json',
        'x-enforce-auth': '1',
      };
      const adminHeaders = {
        Authorization: `Bearer ${staticAdminKey}`,
        'Content-Type': 'application/json',
        'x-enforce-auth': '1',
      };

      // 1. Propose rule for client-drustee
      const propRes = await app.request('/v1/clients/client-drustee/candidate-rules/propose', {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({
          title: 'Drustee Specific Guideline',
          category: 'layout',
          ruleText: 'DRUSTEE_EXCLUSIVE_RULE_SCOPE_TEST',
          rationale: 'Testing cross-client isolation',
        }),
      });
      expect(propRes.status).toBe(201);
      const { proposal } = await propRes.json();

      // 2. Attempt to promote into client-aster
      const promoteRes = await app.request(`/v1/clients/client-aster/candidate-rules/${proposal.id}/promote`, {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      });
      // A foreign candidate is absent from this scope; do not disclose its existence.
      expect(promoteRes.status).toBe(404);

      // 3. Verify client-aster did NOT receive the rule
      const asterDnaRes = await app.request('/v1/clients/client-aster/dna', { headers: adminHeaders });
      const asterDna = await asterDnaRes.json();
      expect(asterDna.guidelines?.layoutRules).not.toContain('DRUSTEE_EXCLUSIVE_RULE_SCOPE_TEST');
    });

    it('SA-03: refuses an unavailable scoped database without retrying DNA writes outside RLS', async () => {
      const lookupCodes: string[] = [];
      const builder: any = new Proxy({}, {
        get(_o, key) {
          if (key === 'executeTakeFirst') return async () => undefined;
          if (key === 'where') return (field: string, _op: string, value: string) => {
            if (field === 'code') lookupCodes.push(value);
            return builder;
          };
          return () => builder;
        },
      });
      const fakeDb: any = {
        selectFrom: () => builder,
        transaction: () => ({ execute: async () => { throw new Error('Injected refusal'); } }),
      };
      const app = createAppWithClientFixtures({ db: fakeDb });
      const headers = {
        Authorization: `Bearer ${staticAdminKey}`,
        'Content-Type': 'application/json',
        'x-enforce-auth': '1',
      };
      expect((await app.request('/v1/clients/client-drustee/dna', {headers})).status).toBe(503);
      const original = clientDnaFixture('client-drustee');
      const res = await app.request('/v1/clients/client-drustee/dna', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...original, name: 'Unsaved Test', expectedVersion: original.version }),
      });
      expect(res.status).toBe(503);
      expect(lookupCodes).toEqual([]);
    });
  });
});
