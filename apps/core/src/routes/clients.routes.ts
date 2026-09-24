import crypto from 'node:crypto';
import type { ClientDnaSnapshot, RouteContext } from './types.js';
import { withRlsContext } from '@hawa/db';
import { validateClientDna, type ClientDNA } from '@hawa/domain';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { computeDnaHash } from '../core-helpers.js';
import { findClientRowId, snapshotFromRow } from '../services/client-row.js';

export function registerClientsRoutes(ctx: RouteContext) {
  const {
    registerRoute,
    clientDnas,
    clientSnapshots,
    verifyRequestAuth,
    problem,
    db,
    clientRepo,
    resolveClientDna,
    broadcastEvent: broadcast,
  } = ctx;

  const defaultTenantId = DEFAULT_TENANT_ID;
  const operatorUserId = OPERATOR_USER_ID;

  // Client DNA Listing
  registerRoute('get', '/clients', async (c: any) => {
    const uniqueDnas = Array.from(new Map(Array.from(clientDnas.values()).map((d) => [d.clientId, d])).values());
    // With a database, a client's history is the versions Postgres holds (SPLIT_PLAN G2); the map
    // only lists the clients hydrated from it. Keyed by the three spellings of a client.
    let storedVersions: Map<string, number> | undefined;
    if (db) {
      try {
        const auth = verifyRequestAuth(c);
        const tenantId = auth.tenantId || defaultTenantId;
        const rows = await withRlsContext(db, { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, (trx) =>
          trx.selectFrom('client_dna_versions as v')
            .innerJoin('clients as cl', (join) => join.onRef('cl.id', '=', 'v.client_id').onRef('cl.tenant_id', '=', 'v.tenant_id'))
            .select((eb) => ['v.client_id', 'cl.code', eb.fn.countAll<string>().as('n')])
            .where('v.tenant_id', '=', tenantId)
            .groupBy(['v.client_id', 'cl.code'])
            .execute());
        storedVersions = new Map();
        for (const row of rows) {
          for (const key of [row.client_id, String(row.code), `client-${row.code}`]) storedVersions.set(key, Number(row.n));
        }
      } catch {
        storedVersions = undefined;
      }
    }
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
      snapshotsCount: storedVersions ? storedVersions.get(d.clientId) ?? 0 : (clientSnapshots.get(d.clientId) || []).length,
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
        // Answered below by the resolver, which reads Postgres again before the map.
      }
    }
    // The shared resolver, as the deleted app.ts copy of this route used (SPLIT_PLAN G2); it was
    // clientDnas.get here, which a database read failure turned into the fixture's DNA.
    const auth = verifyRequestAuth(c);
    const dna = await resolveClientDna(clientId, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role });
    if (!dna) return problem(c, 404, 'DNA Not Found', `No DNA found for client ${clientId}`);
    return c.json(dna);
  });

  // With a database, a client's DNA history is hawa.client_dna_versions and nothing else (SPLIT_PLAN
  // G0 and G2; tests N5 and split-g2-client-dna-postgres): the routes below neither read nor write
  // the snapshot map then. It was the only copy of commit messages and rollback targets, lost on a
  // restart and different in each Core. Without a database (tests) the map is still the store.

  // Client DNA
  registerRoute('post', '/clients/:clientId/dna', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to modify client DNA');
    }
    const clientId = c.req.param('clientId');
    const body = await c.req.json().catch(() => ({}));

    const validation = validateClientDna(body);
    if (!validation.ok) return problem(c, 400, 'Invalid Client DNA', validation.error.message);

    const tenantId = auth.tenantId || defaultTenantId;
    const prevDna = await resolveClientDna(clientId, { tenantId, userId: auth.userId, role: auth.role });
    let targetId: string | undefined = undefined;
    let currentVersion = 0;

    if (db && clientRepo) {
      try {
        const rlsContext = { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' };
        try {
          targetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
            ? clientId
            : await withRlsContext(db, rlsContext, async (trx) => {
                const res = await clientRepo.findByCode(tenantId, clientId, trx);
                if (res) return res.id;
                if (clientId.startsWith('client-')) {
                  return (await clientRepo.findByCode(tenantId, clientId.replace(/^client-/, ''), trx))?.id;
                }
                return undefined;
              });
        } catch (rlsErr: any) {
          if (typeof (db as any).selectFrom === 'function') {
            const res = await clientRepo.findByCode(tenantId, clientId);
            if (res) targetId = res.id;
            else if (clientId.startsWith('client-')) {
              targetId = (await clientRepo.findByCode(tenantId, clientId.replace(/^client-/, '')))?.id;
            }
          } else {
            throw rlsErr;
          }
        }

        if (!targetId) {
          return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
        }

        const resolvedTargetId = targetId;
        try {
          const activeRow = await withRlsContext(db, { tenantId, clientId: resolvedTargetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            return await clientRepo.findActiveDna(tenantId, resolvedTargetId, trx);
          });
          if (activeRow) {
            currentVersion = activeRow.version;
          }
        } catch {
          const activeRow = await clientRepo.findActiveDna(tenantId, resolvedTargetId).catch(() => null);
          if (activeRow) {
            currentVersion = activeRow.version;
          }
        }
      } catch (err: any) {
        if (err.message && err.message.includes('Client Not Found')) throw err;
        return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to query database');
      }
    }

    if (!currentVersion && prevDna) {
      currentVersion = prevDna.version || 0;
    }

    if (body.expectedVersion !== undefined && body.expectedVersion !== currentVersion) {
      return problem(c, 409, 'Conflict', `Optimistic lock failed: expected version ${body.expectedVersion} but current version is ${currentVersion}`);
    }

    const version = currentVersion + 1;
    // Derive author strictly from authenticated identity; ignore/reject forged body.createdBy
    const author = auth.actorId || auth.userId || auth.role || 'operator';

    const dna: ClientDNA = {
      ...body,
      clientId,
      version,
      updatedAt: new Date().toISOString(),
    };
    delete (dna as any).createdBy;
    delete (dna as any).expectedVersion;

    const hash = computeDnaHash(dna);

    if (db && clientRepo && targetId) {
      try {
        await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
          await clientRepo.saveDnaVersion({
            tenantId,
            clientId: targetId,
            version: dna.version,
            dna: { ...dna, __commitMessage: body.commitMessage || `Client DNA updated to v${dna.version}`, __createdBy: author },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
            expectedVersion: body.expectedVersion,
          }, trx);
        });
      } catch (err: any) {
        if (err.message && (err.message.includes('OptimisticConcurrencyConflict') || err.message.includes('unique') || err.code === '23505')) {
          return problem(c, 409, 'Conflict', err.message);
        }
        return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to persist DNA to database');
      }
    }

    clientDnas.set(clientId, dna);

    const snap: ClientDnaSnapshot = {
      snapshotId: `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      clientId,
      version: dna.version,
      sha256: hash,
      commitMessage: body.commitMessage || `Client DNA updated to v${dna.version}`,
      createdBy: author,
      createdAt: new Date().toISOString(),
      dna,
    };
    if (!db) {
      const list = clientSnapshots.get(clientId) || [];
      list.unshift(snap);
      clientSnapshots.set(clientId, list);
    }

    broadcast('dna:updated', { clientId, version: dna.version, sha256: hash });

    return c.json(dna, 201);
  });

  registerRoute('get', '/clients/:clientId/snapshots', async (c: any) => {
    const clientId = c.req.param('clientId');
    if (db && clientRepo) {
      const auth = verifyRequestAuth(c);
      const tenantId = auth.tenantId || defaultTenantId;
      const scope = { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' };
      try {
        const targetId = await findClientRowId(db, clientRepo, scope, clientId);
        if (!targetId) return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
        const rows = await withRlsContext(db, { ...scope, clientId: targetId }, (trx) => clientRepo.listDnaSnapshots(tenantId, targetId, trx));
        return c.json(rows.map(snapshotFromRow), 200);
      } catch (err) {
        // Not the fixture list: an unreadable database is not an empty history.
        return problem(c, 503, 'Database Unavailable', (err as Error)?.message || 'Could not read the client DNA history');
      }
    }
    const list = clientSnapshots.get(clientId) || [];
    return c.json(list, 200);
  });

  registerRoute('post', '/clients/:clientId/snapshots', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to create client snapshot');
    }
    const clientId = c.req.param('clientId');
    const dna = await resolveClientDna(clientId, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role });
    if (!dna) return problem(c, 404, 'DNA Not Found', `No DNA found for client ${clientId}`);

    const body = await c.req.json().catch(() => ({}));
    const tenantId = auth.tenantId || defaultTenantId;
    const scope = { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' };
    // With a database the snapshot is a version of hawa.client_dna_versions, numbered after the
    // active one. A code used to be looked up outside a row-level-security context, find nothing,
    // and leave the snapshot in this process's memory only, while the answer said 201.
    let targetId: string | undefined;
    let currentVersion = dna.version;
    if (db && clientRepo) {
      try {
        targetId = await findClientRowId(db, clientRepo, scope, clientId);
        if (targetId) {
          const rowId = targetId;
          const active = await withRlsContext(db, { ...scope, clientId: rowId }, (trx) => clientRepo.findActiveDna(tenantId, rowId, trx));
          if (active) currentVersion = active.version;
        }
      } catch (err) {
        return problem(c, 503, 'Database Unavailable', (err as Error)?.message || 'Could not read the client');
      }
      if (!targetId) return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
    }
    if (body.expectedVersion !== undefined && body.expectedVersion !== currentVersion) {
      return problem(c, 409, 'Conflict', `Optimistic lock failed: expected version ${body.expectedVersion} but current version is ${currentVersion}`);
    }

    const newVersion = currentVersion + 1;
    const author = (auth.actorId && auth.actorId !== 'test_harness' && auth.actorId !== 'anonymous')
      ? auth.actorId
      : (body.createdBy || auth.userId || auth.role || 'operator');

    const updatedDna: ClientDNA = {
      ...dna,
      version: newVersion,
      updatedAt: new Date().toISOString(),
    };
    delete (updatedDna as any).createdBy;
    delete (updatedDna as any).expectedVersion;

    const hash = computeDnaHash(updatedDna);

    const commitMessage = body.commitMessage || `Manual governance snapshot (v${newVersion})`;
    if (db && clientRepo && targetId) {
      const rowId = targetId;
      try {
        await withRlsContext(db, { ...scope, clientId: rowId }, async (trx) => {
          await clientRepo.saveDnaVersion({
            tenantId,
            clientId: rowId,
            version: newVersion,
            dna: { ...updatedDna, __commitMessage: commitMessage, __createdBy: author },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
            expectedVersion: body.expectedVersion !== undefined ? body.expectedVersion : undefined,
          }, trx);
        });
      } catch (err: any) {
        if (err.message && err.message.includes('OptimisticConcurrencyConflict')) {
          return problem(c, 409, 'Conflict', err.message);
        }
        return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to persist snapshot to database');
      }
    }

    clientDnas.set(clientId, updatedDna);

    const snap: ClientDnaSnapshot = {
      snapshotId: `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      clientId,
      version: newVersion,
      sha256: hash,
      commitMessage,
      createdBy: author,
      createdAt: new Date().toISOString(),
      dna: updatedDna,
    };

    if (!db) {
      const list = clientSnapshots.get(clientId) || [];
      list.unshift(snap);
      clientSnapshots.set(clientId, list);
    }

    broadcast('dna:snapshot_created', { clientId, version: newVersion, sha256: hash, snapshotId: snap.snapshotId });

    return c.json(snap, 201);
  });

  registerRoute('post', '/clients/:clientId/dna/rollback', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to rollback client DNA');
    }
    const clientId = c.req.param('clientId');
    const body = await c.req.json().catch(() => ({}));
    const { targetVersion, snapshotId, reason } = body;

    // SA-01: Derive role strictly from auth.role; do NOT use body.role
    const role = (auth.role || 'operator') as string;
    if (role !== 'art_director' && role !== 'creative_director' && role !== 'administrator') {
      return problem(c, 403, 'Forbidden', 'Only art_director, creative_director, or administrator can rollback client DNA');
    }

    const currentDna = await resolveClientDna(clientId, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role });
    if (!currentDna) {
      return problem(c, 404, 'DNA Not Found', `No DNA found for client ${clientId}`);
    }

    // With a database the version to return to, and the one it follows, are Postgres's: the
    // snapshot list used to be this process's memory, so a version saved through another Core or
    // before a restart could not be rolled back to.
    const tenantId = auth.tenantId || defaultTenantId;
    const scope = { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' };
    const matches = (s: { version: number; snapshotId: string }) =>
      (targetVersion && s.version === targetVersion) || (snapshotId && s.snapshotId === snapshotId);
    let targetId: string | undefined;
    let activeVersion = currentDna.version || 1;
    let targetSnap: { version: number; snapshotId: string; dna: ClientDNA } | undefined;
    if (db && clientRepo) {
      try {
        targetId = await findClientRowId(db, clientRepo, scope, clientId);
        if (targetId) {
          const rowId = targetId;
          const rows = await withRlsContext(db, { ...scope, clientId: rowId }, (trx) => clientRepo.listDnaSnapshots(tenantId, rowId, trx));
          targetSnap = rows.map(snapshotFromRow).find(matches);
          const active = rows.find((r) => r.status === 'active');
          if (active) activeVersion = active.version;
        }
      } catch (err) {
        return problem(c, 503, 'Database Unavailable', (err as Error)?.message || 'Could not read the client DNA history');
      }
      if (!targetId) return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
    } else {
      targetSnap = (clientSnapshots.get(clientId) || []).find(matches);
    }

    if (!targetSnap) {
      return problem(c, 404, 'Snapshot Not Found', `No snapshot found matching version ${targetVersion || snapshotId}`);
    }

    const newVersion = activeVersion + 1;
    const author = auth.userId || auth.role || 'system';
    const restoredDna: ClientDNA = {
      ...targetSnap.dna,
      clientId,
      version: newVersion,
      updatedAt: new Date().toISOString(),
    };
    // The restored version gets its own commit message below, not the one it was saved with.
    delete (restoredDna as ClientDNA & { __commitMessage?: string }).__commitMessage;
    delete (restoredDna as ClientDNA & { __createdBy?: string }).__createdBy;

    const hash = computeDnaHash(restoredDna);
    const rollbackSnap: ClientDnaSnapshot = {
      snapshotId: `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      clientId,
      version: newVersion,
      sha256: hash,
      commitMessage: `Rollback to baseline v${targetSnap.version}: ${reason || 'Governance rollback'} (Executed by ${author})`,
      createdBy: author,
      createdAt: new Date().toISOString(),
      dna: restoredDna,
    };

    if (db && clientRepo && targetId) {
      const rowId = targetId;
      try {
        await withRlsContext(db, { ...scope, clientId: rowId }, async (trx) => {
          await clientRepo.saveDnaVersion({
            tenantId,
            clientId: rowId,
            version: newVersion,
            dna: { ...restoredDna, __commitMessage: rollbackSnap.commitMessage, __createdBy: rollbackSnap.createdBy },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
          }, trx);
        });
      } catch (err: any) {
        return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to persist rollback to database');
      }
    }

    clientDnas.set(clientId, restoredDna);
    if (!db) {
      const list = clientSnapshots.get(clientId) || [];
      list.unshift(rollbackSnap);
      clientSnapshots.set(clientId, list);
    }

    broadcast('dna:rollback', {
      clientId,
      fromVersion: currentDna.version,
      toVersion: newVersion,
      revertedToBaselineVersion: targetSnap.version,
      sha256: hash,
    });
    broadcast('dna:snapshot_created', {
      clientId,
      version: newVersion,
      sha256: hash,
      snapshotId: rollbackSnap.snapshotId,
    });

    return c.json({
      rolledBack: true,
      activeVersion: newVersion,
      revertedToVersion: targetSnap.version,
      activeDna: restoredDna,
      snapshot: rollbackSnap,
    }, 200);
  });
}
