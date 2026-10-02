import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import type { AuthContext } from '../routes/types.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';

export interface StreamEvent {
  id: string;
  event: string;
  data: unknown;
}

function uuid(value: string): boolean;
function uuid(value: unknown): value is string;
function uuid(value: unknown): boolean {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
const officeEvents = new Set(['operations:kill_switch_toggled',
  'operations:canva_outage_simulated', 'operations:canva_recovery_simulated']);

/** A broadcast's client claim is not authority. Read its current resource under runtime RLS. */
export async function mayReadStreamEvent(db: Kysely<Database> | null | undefined, auth: AuthContext,
  event: StreamEvent): Promise<boolean> {
  if (!db || !auth.authenticated || !uuid(auth.tenantId) || !uuid(auth.userId) || !auth.role || auth.role === 'service') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  const data = event.data as Record<string, unknown>;
  const tenantId = data.tenantId === 'tenant-default' ? DEFAULT_TENANT_ID : data.tenantId;
  if (!uuid(tenantId) || tenantId.toLowerCase() !== auth.tenantId.toLowerCase()) return false;
  const taskId = 'taskId' in data ? data.taskId : (event.event === 'task:created' ? data.id : undefined);
  const clientKey = data.clientId;
  if (event.event.startsWith('task:') && !uuid(taskId)) return false;
  if (taskId !== undefined && !uuid(taskId)) return false;
  if (clientKey !== undefined && clientKey !== null &&
      (typeof clientKey !== 'string' || !clientKey.trim() || clientKey.length > 200)) return false;
  const scope = { tenantId: auth.tenantId, userId: auth.userId, role: auth.role };
  return withRlsContext(db, scope, async trx => {
    let clientId: string | undefined;
    if (typeof clientKey === 'string') {
      const client = await trx.selectFrom('clients').select('id').where('tenant_id', '=', scope.tenantId)
        .where(sql<boolean>`hawa.is_tenant_member(${scope.tenantId}::uuid)`)
        .where(eb => uuid(clientKey) ? eb('id', '=', clientKey) : eb('code', 'in',
          clientKey.startsWith('client-') ? [clientKey, clientKey.slice(7)] : [clientKey]))
        // Preserve findByCode's exact-code priority before trying the legacy prefix.
        .orderBy(sql<boolean>`code=${clientKey}`, 'desc').limit(1).executeTakeFirst();
      if (!client) return false;
      clientId = client.id;
    }
    if (taskId !== undefined) {
      const task = await trx.selectFrom('tasks').select(['id', 'client_id'])
        .where('tenant_id', '=', scope.tenantId).where('id', '=', taskId)
        .where(sql<boolean>`hawa.is_tenant_member(${scope.tenantId}::uuid)`).executeTakeFirst();
      if (!task || (clientId && task.client_id !== clientId) || (clientKey === null && task.client_id !== null)) return false;
      return true;
    }
    if (clientId) return true;
    if (!officeEvents.has(event.event)) return false;
    const access = await sql<{ allowed: boolean }>`SELECT hawa.has_tenant_role(${scope.tenantId}::uuid,
      ARRAY['administrator','operator','auditor']::hawa.membership_role[]) AS allowed`.execute(trx);
    return access.rows[0]?.allowed === true;
  });
}
