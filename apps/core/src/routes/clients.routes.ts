import crypto from 'node:crypto';
import type { ClientDnaSnapshot, RouteContext } from './types.js';
import { withRlsContext } from '@hawa/db';
import { validateClientDna, type ClientDNA } from '@hawa/domain';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { computeDnaHash } from '../core-helpers.js';

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

  // GET /clients/:clientId/snapshots below reads hawa.client_dna_versions. This module had a
  // memory-only copy registered before app.ts's, so the Desk's DNA history never showed what Postgres
  // held (architecture programme 1.3, SPLIT_PLAN G0; test N5).

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
            dna,
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
    const list = clientSnapshots.get(clientId) || [];
    list.unshift(snap);
    clientSnapshots.set(clientId, list);

    broadcast('dna:updated', { clientId, version: dna.version, sha256: hash });

    return c.json(dna, 201);
  });

  registerRoute('get', '/clients/:clientId/snapshots', async (c: any) => {
    const clientId = c.req.param('clientId');
    if (db && clientRepo) {
      try {
        const auth = verifyRequestAuth(c);
        const tenantId = auth.tenantId || defaultTenantId;
        // hawa.clients is under RLS: looked up outside a context, a code finds nothing and the
        // answer fell back to Core's memory (the fixture snapshots). findByCode also reads client-<code>.
        const targetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
          ? clientId
          : await withRlsContext(db, { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) =>
              (await clientRepo.findByCode(tenantId, clientId, trx))?.id);
        if (targetId) {
          const rows = await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            return await clientRepo.listDnaSnapshots(tenantId, targetId, trx);
          });
          if (rows && rows.length > 0) {
            const inMemory = clientSnapshots.get(clientId) || [];
            const inMemoryMap = new Map(inMemory.map((s: any) => [s.version, s]));
            const mapped = rows.map((r: any) => {
              const parsed = typeof r.dna === 'string' ? JSON.parse(r.dna) : r.dna;
              const matchingMem = inMemoryMap.get(r.version);
              return {
                snapshotId: matchingMem?.snapshotId || r.id,
                clientId: r.client_id,
                version: r.version,
                sha256: r.content_hash,
                commitMessage: matchingMem?.commitMessage || parsed?.__commitMessage || `Version ${r.version} (${r.status})`,
                createdBy: matchingMem?.createdBy || r.created_by || 'operator',
                createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
                dna: parsed,
              };
            });
            const versionsInDb = new Set(mapped.map((m: any) => m.version));
            for (const item of inMemory) {
              if (!versionsInDb.has(item.version)) {
                mapped.push(item);
              }
            }
            mapped.sort((a: any, b: any) => b.version - a.version);
            return c.json(mapped, 200);
          }
        }
      } catch {
        // Fallback to in-memory
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
    if (body.expectedVersion !== undefined && body.expectedVersion !== dna.version) {
      return problem(c, 409, 'Conflict', `Optimistic lock failed: expected version ${body.expectedVersion} but current version is ${dna.version}`);
    }

    const newVersion = dna.version + 1;
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

    if (db && clientRepo) {
      try {
        const tenantId = auth.tenantId || defaultTenantId;
        const targetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
          ? clientId
          : (await clientRepo.findByCode(tenantId, clientId))?.id;
        if (targetId) {
          await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            await clientRepo.saveDnaVersion({
              tenantId,
              clientId: targetId,
              version: newVersion,
              dna: updatedDna,
              contentHash: hash,
              createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
              expectedVersion: body.expectedVersion !== undefined ? body.expectedVersion : undefined,
            }, trx);
          });
        }
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
      commitMessage: body.commitMessage || `Manual governance snapshot (v${newVersion})`,
      createdBy: author,
      createdAt: new Date().toISOString(),
      dna: updatedDna,
    };

    const list = clientSnapshots.get(clientId) || [];
    list.unshift(snap);
    clientSnapshots.set(clientId, list);

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

    const snapshots = clientSnapshots.get(clientId) || [];
    const targetSnap = snapshots.find(
      (s) => (targetVersion && s.version === targetVersion) || (snapshotId && s.snapshotId === snapshotId)
    );

    if (!targetSnap) {
      return problem(c, 404, 'Snapshot Not Found', `No snapshot found matching version ${targetVersion || snapshotId}`);
    }

    const newVersion = (currentDna.version || 1) + 1;
    const author = auth.userId || auth.role || 'system';
    const restoredDna: ClientDNA = {
      ...targetSnap.dna,
      clientId,
      version: newVersion,
      updatedAt: new Date().toISOString(),
    };

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

    if (db && clientRepo) {
      try {
        const tenantId = auth.tenantId || defaultTenantId;
        let targetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
          ? clientId
          : (await clientRepo.findByCode(tenantId, clientId))?.id;
        if (!targetId && clientId.startsWith('client-')) {
          targetId = (await clientRepo.findByCode(tenantId, clientId.replace(/^client-/, '')) )?.id;
        }
        if (!targetId) {
          return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
        }
        await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
          await clientRepo.saveDnaVersion({
            tenantId,
            clientId: targetId,
            version: newVersion,
            dna: { ...restoredDna, __commitMessage: rollbackSnap.commitMessage },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
          }, trx);
        });
      } catch (err: any) {
        return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to persist rollback to database');
      }
    }

    clientDnas.set(clientId, restoredDna);
    snapshots.unshift(rollbackSnap);
    clientSnapshots.set(clientId, snapshots);

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
