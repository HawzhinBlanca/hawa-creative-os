import crypto from 'node:crypto';
import { sql, withRlsContext } from '@hawa/db';
import { isValidUuid } from '../core-helpers.js';
import { lockNamedOfficeAdministrator } from '../services/named-review-authority.js';
import type { RouteContext } from './types.js';

class AssignmentError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422, readonly title: string, message: string) {
    super(message);
  }
}

type AssignmentRow = {
  id: string; client_id: string; project_id: string | null; user_id: string;
  active: boolean; version: string;
};

/** Named-administrator permission changes, with one immutable event per version. */
export function registerOfficeReviewAdminRoutes(ctx: RouteContext): void {
  const { registerRoute, verifyRequestAuth, problem, db } = ctx;

  async function administrator(c: any) {
    const auth = verifyRequestAuth(c);
    const token = ctx.bearerTokenOf?.(c);
    if (!db || !auth.authenticated || auth.authMethod !== 'google_oidc' || !token ||
        !auth.tenantId || !auth.userId) return null;
    return { tenantId: auth.tenantId, userId: auth.userId,
      sessionHash: crypto.createHash('sha256').update(token).digest('hex') };
  }

  registerRoute('get', '/office/review-directory', async (c: any) => {
    const admin = await administrator(c);
    if (!admin) return problem(c, 403, 'Named Administrator Required');
    const directory = await withRlsContext<{
      reviewers: Array<{ userId: string; displayName: string; clientId: string; clientName: string }>;
      projects: Array<{ id: string; clientId: string; name: string }>;
    } | null>(db!, { tenantId: admin.tenantId, userId: admin.userId, role: 'administrator' }, async (trx) => {
      if (!await lockNamedOfficeAdministrator(trx, admin)) return null;
      const reviewers = (await sql<{
        user_id: string; display_name: string; client_id: string; client_name: string;
      }>`SELECT u.id AS user_id,u.display_name,cl.id AS client_id,cl.name AS client_name
        FROM hawa.users u
        JOIN hawa.tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id=${admin.tenantId}::uuid
          AND tm.role='approver' AND tm.active
        JOIN hawa.client_memberships cm ON cm.user_id=u.id AND cm.tenant_id=tm.tenant_id
          AND cm.role='approver' AND cm.active
        JOIN hawa.clients cl ON cl.id=cm.client_id AND cl.tenant_id=cm.tenant_id AND cl.status='active'
        WHERE u.disabled_at IS NULL AND u.external_subject IS NOT NULL
        ORDER BY cl.name,u.display_name,u.id LIMIT 1000`.execute(trx)).rows;
      const projects = (await sql<{ id: string; client_id: string; name: string }>`
        SELECT p.id,p.client_id,p.name FROM hawa.projects p
        JOIN hawa.clients cl ON cl.id=p.client_id AND cl.tenant_id=p.tenant_id AND cl.status='active'
        WHERE p.tenant_id=${admin.tenantId}::uuid AND p.status='active'
        ORDER BY cl.name,p.name,p.id LIMIT 1000`.execute(trx)).rows;
      return { reviewers: reviewers.map((row) => ({ userId: row.user_id,
        displayName: row.display_name, clientId: row.client_id, clientName: row.client_name })),
        projects: projects.map((row) => ({ id: row.id, clientId: row.client_id, name: row.name })) };
    });
    if (!directory) return problem(c, 403, 'Named Administrator Required');
    return c.json(directory);
  });

  registerRoute('get', '/office/review-assignments', async (c: any) => {
    const admin = await administrator(c);
    if (!admin) return problem(c, 403, 'Named Administrator Required');
    const rows = await withRlsContext<AssignmentRow[] | null>(db!, { tenantId: admin.tenantId, userId: admin.userId, role: 'administrator' },
      async (trx) => {
        if (!await lockNamedOfficeAdministrator(trx, admin)) return null;
        return (await sql<AssignmentRow>`SELECT id,client_id,project_id,user_id,active,version
          FROM hawa.office_review_assignments WHERE tenant_id=${admin.tenantId}::uuid
          ORDER BY updated_at DESC,id LIMIT 500`.execute(trx)).rows;
      });
    if (!rows) return problem(c, 403, 'Named Administrator Required');
    return c.json(rows.map((row) => ({ id: row.id, clientId: row.client_id,
      projectId: row.project_id, userId: row.user_id, active: row.active, version: Number(row.version) })));
  });

  registerRoute('get', '/office/review-assignments/:assignmentId/events', async (c: any) => {
    const assignmentId = c.req.param('assignmentId');
    if (!isValidUuid(assignmentId)) return problem(c, 422, 'Invalid Assignment ID');
    const admin = await administrator(c);
    if (!admin) return problem(c, 403, 'Named Administrator Required');
    const rows = await withRlsContext<Record<string, unknown>[] | null>(db!, { tenantId: admin.tenantId, userId: admin.userId, role: 'administrator' },
      async (trx) => {
        if (!await lockNamedOfficeAdministrator(trx, admin)) return null;
        return (await sql<Record<string, unknown>>`SELECT id,action_id,actor_user_id,actor_database_role,action,assignment_version,
          client_id,project_id,reviewer_user_id,reason,occurred_at
          FROM hawa.office_review_assignment_events
          WHERE tenant_id=${admin.tenantId}::uuid AND assignment_id=${assignmentId}::uuid
          ORDER BY assignment_version DESC LIMIT 500`.execute(trx)).rows;
      });
    if (!rows) return problem(c, 403, 'Named Administrator Required');
    return c.json(rows);
  });

  registerRoute('put', '/office/review-assignments/:assignmentId', async (c: any) => {
    const assignmentId = c.req.param('assignmentId');
    const actionId = c.req.header('Idempotency-Key');
    if (!isValidUuid(assignmentId) || !actionId || !isValidUuid(actionId)) {
      return problem(c, 422, 'Assignment Action Key Required', 'Use UUID assignment and Idempotency-Key values');
    }
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).some((key) =>
        !['clientId', 'projectId', 'userId', 'active', 'expectedVersion', 'reason'].includes(key)) ||
        !isValidUuid(body.clientId as string) || !isValidUuid(body.userId as string) ||
        (body.projectId !== null && !isValidUuid(body.projectId as string)) ||
        typeof body.active !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) ||
        (body.expectedVersion as number) < 0 || typeof body.reason !== 'string' ||
        !body.reason.trim() || body.reason.length > 500 ||
        (body.expectedVersion === 0 && body.active === false)) {
      return problem(c, 422, 'Invalid Review Assignment',
        'Supply user, client, explicit project or null, active state, expected version and reason');
    }
    const admin = await administrator(c);
    if (!admin) return problem(c, 403, 'Named Administrator Required');
    const clientId = body.clientId as string;
    const projectId = body.projectId as string | null;
    const userId = body.userId as string;
    const active = body.active as boolean;
    const expectedVersion = body.expectedVersion as number;
    const reason = (body.reason as string).trim();
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ assignmentId,
      administratorId: admin.userId, clientId, projectId, userId, active, expectedVersion, reason })).digest('hex');
    try {
      const result = await withRlsContext<{ id: string; version: number; replayed: boolean; created: boolean }>(db!,
        { tenantId: admin.tenantId, userId: admin.userId, role: 'administrator' }, async (trx) => {
          if (!await lockNamedOfficeAdministrator(trx, admin)) {
            throw new AssignmentError(403, 'Named Administrator Required', 'The administrator session or role is inactive');
          }
          await sql`SELECT pg_advisory_xact_lock(hashtext(${admin.tenantId}),hashtext(${actionId}))`.execute(trx);
          const prior = (await sql<{ assignment_id: string; request_sha256: string; assignment_version: string }>`
            SELECT assignment_id,request_sha256,assignment_version
            FROM hawa.office_review_assignment_events
            WHERE tenant_id=${admin.tenantId}::uuid AND action_id=${actionId}::uuid`.execute(trx)).rows[0];
          if (prior) {
            if (prior.assignment_id !== assignmentId || prior.request_sha256 !== requestHash) {
              throw new AssignmentError(409, 'Assignment Action Conflict', 'This action key was used for a different change');
            }
            return { id: assignmentId, version: Number(prior.assignment_version), replayed: true, created: false };
          }
          const existing = (await sql<AssignmentRow>`SELECT id,client_id,project_id,user_id,active,version
            FROM hawa.office_review_assignments
            WHERE tenant_id=${admin.tenantId}::uuid AND id=${assignmentId}::uuid FOR UPDATE`.execute(trx)).rows[0];
          if (existing && (existing.client_id !== clientId || existing.project_id !== projectId || existing.user_id !== userId)) {
            throw new AssignmentError(409, 'Assignment Scope Conflict', 'This assignment ID already names another reviewer or scope');
          }
          if (Number(existing?.version ?? 0) !== expectedVersion) {
            throw new AssignmentError(409, 'Assignment Version Conflict', 'Refresh the assignment and retry with its current version');
          }
          if (active) {
            const eligible = (await sql<{ candidate_user_id: string }>`SELECT * FROM hawa.lock_office_review_candidate(
              ${admin.tenantId}::uuid,${userId}::uuid,${clientId}::uuid,${projectId}::uuid)`.execute(trx)).rows[0];
            if (!eligible) throw new AssignmentError(422, 'Reviewer Not Eligible',
              'Reviewer needs an enabled Google subject, active approver memberships and a matching active project');
          }
          await sql`SELECT set_config('hawa.office_review_action_id',${actionId},true),
            set_config('hawa.office_review_request_sha256',${requestHash},true),
            set_config('hawa.office_review_reason',${reason},true)`.execute(trx);
          const row = existing
            ? (await sql<AssignmentRow>`UPDATE hawa.office_review_assignments SET active=${active}
                WHERE tenant_id=${admin.tenantId}::uuid AND id=${assignmentId}::uuid
                RETURNING id,client_id,project_id,user_id,active,version`.execute(trx)).rows[0]
            : (await sql<AssignmentRow>`INSERT INTO hawa.office_review_assignments
                (id,tenant_id,client_id,project_id,user_id,active)
                VALUES (${assignmentId}::uuid,${admin.tenantId}::uuid,${clientId}::uuid,${projectId}::uuid,${userId}::uuid,true)
                RETURNING id,client_id,project_id,user_id,active,version`.execute(trx)).rows[0];
          return { id: row.id, version: Number(row.version), replayed: false, created: !existing };
        });
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof AssignmentError) return problem(c, error.status, error.title, error.message);
      if ((error as { code?: string })?.code === '23505') {
        return problem(c, 409, 'Assignment Already Exists',
          'This reviewer already has an assignment for that client and project');
      }
      return problem(c, 503, 'Assignment Storage Unavailable', 'The assignment was not confirmed; retry the same action key');
    }
  });
}
