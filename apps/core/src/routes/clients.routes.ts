import type { RouteContext } from './types.js';
import { withRlsContext } from '@hawa/db';

export function registerClientsRoutes(ctx: RouteContext) {
  const {
    registerRoute,
    clientDnas,
    clientSnapshots,
    verifyRequestAuth,
    problem,
    db,
    clientRepo,
  } = ctx;

  const defaultTenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';

  // Client DNA Listing
  registerRoute('get', '/clients', (c: any) => {
    const uniqueDnas = Array.from(new Map(Array.from(clientDnas.values()).map((d) => [d.clientId, d])).values());
    const list = uniqueDnas.map((d) => ({
      clientId: d.clientId,
      name: d.name,
      code: d.code,
      version: d.version,
      status: d.status,
      defaultLocale: d.defaultLocale,
      defaultDirection: d.defaultDirection,
      updatedAt: d.updatedAt,
      colorsCount: d.colors.length,
      rulesCount: d.guidelines.layoutRules.length,
      snapshotsCount: (clientSnapshots.get(d.clientId) || []).length,
    }));
    return c.json(list, 200);
  });

  // Client DNA Detail
  registerRoute('get', '/clients/:clientId/dna', async (c: any) => {
    const clientId = c.req.param('clientId');
    if (db && clientRepo) {
      try {
        const auth = verifyRequestAuth(c);
        const tenantId = auth.tenantId || defaultTenantId;
        const rlsContext = { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' };
        let targetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
          ? clientId
          : await withRlsContext(db, rlsContext, async (trx) => {
              const res = await clientRepo.findByCode(tenantId, clientId, trx);
              if (res) return res.id;
              if (clientId.startsWith('client-')) {
                return (await clientRepo.findByCode(tenantId, clientId.replace(/^client-/, ''), trx))?.id;
              }
              return undefined;
            });
        if (targetId) {
          const row = await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            return await clientRepo.findActiveDna(tenantId, targetId, trx);
          });
          if (row && row.dna) {
            const parsed = typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna;
            return c.json(parsed);
          }
        }
      } catch {
        // Fallback to in-memory
      }
    }
    const dna = clientDnas.get(clientId);
    if (!dna) return problem(c, 404, 'DNA Not Found', `No DNA found for client ${clientId}`);
    return c.json(dna);
  });

  // GET /clients/:clientId/snapshots is app.ts's, which reads hawa.client_dna_versions. This module
  // had a memory-only copy registered first, so the Desk's DNA history never showed what Postgres
  // held (architecture programme 1.3, SPLIT_PLAN G0; test N5).
}
