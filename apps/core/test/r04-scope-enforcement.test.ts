import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { DesignStudioService, type Scope } from '../src/services/design-studio/design-studio-service.js';
import { CanvaFlowError } from '../src/services/canva-connect-service.js';

describe('R04: Enforce Principal, Tenant, Client, Task, and Run Scope Everywhere (FR-011, FR-043, FR-066-069, FR-077, NFR-006, NFR-007)', () => {
  const defaultTenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const adminUserId = '00000000-0000-4000-b000-000000000002';
  const staticAdminKey = process.env.HAWA_ADMIN_KEY || 'hawa_admin_dev';

  describe('1. Long-Lived Static Bearer Keys Forbidden in URL Query Parameters', () => {
    it('rejects static admin or operator bearer tokens passed via access_token query param', async () => {
      const app = createApp();

      // Attempting to pass static admin key as query param
      const res = await app.request(`/v1/events/stream?access_token=${encodeURIComponent(staticAdminKey)}`);
      expect(res.status).toBe(401);
    });

    it('permits valid short-lived issued desk session via access_token query param', async () => {
      const app = createApp();

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

      // Connecting with issued session token via query parameter
      const streamRes = await app.request(`/v1/events/stream?access_token=${encodeURIComponent(session.token)}`);
      // Connection must succeed (200 with text/event-stream)
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
    });

    it('rejects unauthenticated requests to /events/stream', async () => {
      const app = createApp();
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
    service.tx = async (_scope: unknown, fn: (db: any) => any) => fn({});

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
      const app = createApp();

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
});
