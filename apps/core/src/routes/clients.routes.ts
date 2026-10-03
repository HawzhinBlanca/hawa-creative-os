import crypto from 'node:crypto';
import type { ClientDnaSnapshot, RouteContext } from './types.js';
import { withRlsContext } from '@hawa/db';
import { validateClientDna, type ClientDNA } from '@hawa/domain';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { computeDnaHash } from '../core-helpers.js';
import { log } from '../logging.js';
import { findClientRowId, snapshotFromRow } from '../services/client-row.js';
import { ModelConsentError, modelReadingAfterSave, readClientModelConsent, recordClientModelConsent,
  saveDnaVersionKeepingConsent, type DnaSaveConsent } from '../services/client-model-consent.js';

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

  /**
   * ADR-239: after a DNA save, whether model reading is on for the client, read through the real
   * egressAllowed(); off, with the reason, so the Desk can say so. Null without a database or when the
   * read fails (the save itself is committed).
   */
  const modelReadingOf = async (auth: any, clientRowId: string, consent: DnaSaveConsent) => {
    if (!db) return null;
    try {
      return await modelReadingAfterSave(db, { tenantId: auth.tenantId || defaultTenantId, userId: auth.userId || operatorUserId,
        role: auth.role || 'administrator' }, clientRowId, consent);
    } catch {
      return { openai: false, reason: 'Core could not read whether model reading is on for this client after the save.' };
    }
  };

  /** A client as the list shows it, from its DNA and the number of versions kept of it. */
  const listed = (d: ClientDNA, snapshotsCount: number) => ({
    clientId: d.clientId,
    name: d.name,
    code: d.code,
    version: d.version,
    status: d.status,
    defaultLocale: d.defaultLocale,
    defaultDirection: d.defaultDirection,
    updatedAt: d.updatedAt,
    colorsCount: d.colors?.length ?? 0,
    rulesCount: d.guidelines?.layoutRules?.length ?? 0,
    snapshotsCount,
  });

  // Client DNA Listing. With a database, each client's active DNA and its number of versions, as
  // Postgres holds them now (SPLIT_PLAN G2 and the cleanup step): this listed the DNA this process
  // had loaded at start-up, so a client saved by another Core showed its old name and colours.
  registerRoute('get', '/clients', async (c: any) => {
    if (db) {
      const auth = verifyRequestAuth(c);
      const tenantId = auth.tenantId || defaultTenantId;
      try {
        const rows = await withRlsContext(db, { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, (trx) =>
          trx.selectFrom('client_dna_versions as v')
            .innerJoin('clients as client', join => join.onRef('client.id', '=', 'v.client_id').onRef('client.tenant_id', '=', 'v.tenant_id'))
            .select((eb) => [
              'v.client_id',
              'v.dna',
              'v.version',
              eb.selectFrom('client_dna_versions as all_v')
                .select((inner) => inner.fn.countAll<string>().as('n'))
                .whereRef('all_v.client_id', '=', 'v.client_id')
                .whereRef('all_v.tenant_id', '=', 'v.tenant_id')
                .as('versions'),
            ])
            .where('v.tenant_id', '=', tenantId)
            .where('v.status', '=', 'active')
            .where('client.status', '=', 'active')
            .orderBy('client.name').orderBy('client.id')
            .execute());
        const list = rows.flatMap((row) => {
          const dna = (typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna) as ClientDNA | null;
          return dna && typeof dna === 'object' ? [listed({ ...dna, clientId: row.client_id, version: row.version, status: 'active' }, Number(row.versions ?? 0))] : [];
        });
        return c.json(list, 200);
      } catch (err) {
        return problem(c, 503, 'Database Unavailable', (err as Error)?.message || 'Could not read the clients');
      }
    }
    // Without a database, the DNA this process holds, keyed three ways per client.
    const uniqueDnas = Array.from(new Map(Array.from(clientDnas.values()).map((d) => [d.clientId, d])).values());
    return c.json(uniqueDnas.map((d) => listed(d, (clientSnapshots.get(d.clientId) || []).length)), 200);
  });

  // Client DNA Detail
  registerRoute('get', '/clients/:clientId/dna', async (c: any) => {
    const clientId = c.req.param('clientId');
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
        targetId = await findClientRowId(db, clientRepo, rlsContext, clientId);

        if (!targetId) {
          return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
        }

        const resolvedTargetId = targetId;
        const activeRow = await withRlsContext(db, { ...rlsContext, clientId: resolvedTargetId },
          trx => clientRepo.findActiveDna(tenantId, resolvedTargetId, trx));
        if (activeRow) currentVersion = activeRow.version;
      } catch (err: any) {
        if (err.message && err.message.includes('Client Not Found')) throw err;
        return problem(c, 503, 'Client DNA Unavailable', 'The current client and DNA version could not be verified; try again');
      }
    }

    if (!db && !currentVersion && prevDna) {
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
    // ADR-239: what the Desk sends back is what GET /dna and this answer gave it: the previous version's
    // commit metadata (outside the content hash) and the model-reading answer are not DNA.
    delete (dna as any).__commitMessage;
    delete (dna as any).__createdBy;
    delete (dna as any).modelReading;

    const hash = computeDnaHash(dna);

    let consent: DnaSaveConsent | null = null;
    if (db && clientRepo && targetId) {
      try {
        consent = await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
          return (await saveDnaVersionKeepingConsent(trx, clientRepo, auth, {
            tenantId,
            clientId: targetId,
            version: dna.version,
            dna: { ...dna, __commitMessage: body.commitMessage || `Client DNA updated to v${dna.version}`, __createdBy: author },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
            expectedVersion: body.expectedVersion,
            via: 'dna',
          })).consent;
        });
      } catch (err: any) {
        if (err.message && (err.message.includes('OptimisticConcurrencyConflict') || err.message.includes('unique') || err.code === '23505')) {
          return problem(c, 409, 'Conflict', 'The client DNA changed since it was read; reload it and save again');
        }
        if (err?.code === '42501') return problem(c, 403, 'Forbidden', 'Your role may not change this client\'s DNA');
        log.error('[core:clients:dna] DNA not saved:', err?.message || err);
        return problem(c, 500, 'Database Transaction Failed', 'The client DNA could not be saved; try again');
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

    const modelReading = consent && targetId ? await modelReadingOf(auth, targetId, consent) : null;
    return c.json(modelReading ? { ...dna, modelReading } : dna, 201);
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
    let consent: DnaSaveConsent | null = null;
    if (db && clientRepo && targetId) {
      const rowId = targetId;
      try {
        consent = await withRlsContext(db, { ...scope, clientId: rowId }, async (trx) => {
          return (await saveDnaVersionKeepingConsent(trx, clientRepo, auth, {
            tenantId,
            clientId: rowId,
            version: newVersion,
            dna: { ...updatedDna, __commitMessage: commitMessage, __createdBy: author },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
            expectedVersion: body.expectedVersion !== undefined ? body.expectedVersion : undefined,
            via: 'snapshot',
          })).consent;
        });
      } catch (err: any) {
        if (err.message && err.message.includes('OptimisticConcurrencyConflict')) {
          return problem(c, 409, 'Conflict', 'The client DNA changed since it was read; reload it and try again');
        }
        if (err?.code === '42501') return problem(c, 403, 'Forbidden', 'Your role may not change this client\'s DNA');
        log.error('[core:clients:snapshot] snapshot not saved:', err?.message || err);
        return problem(c, 500, 'Database Transaction Failed', 'The snapshot could not be saved; try again');
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

    const modelReading = consent && targetId ? await modelReadingOf(auth, targetId, consent) : null;
    return c.json(modelReading ? { ...snap, modelReading } : snap, 201);
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

    let consent: DnaSaveConsent | null = null;
    if (db && clientRepo && targetId) {
      const rowId = targetId;
      try {
        consent = await withRlsContext(db, { ...scope, clientId: rowId }, async (trx) => {
          return (await saveDnaVersionKeepingConsent(trx, clientRepo, auth, {
            tenantId,
            clientId: rowId,
            version: newVersion,
            dna: { ...restoredDna, __commitMessage: rollbackSnap.commitMessage, __createdBy: rollbackSnap.createdBy },
            contentHash: hash,
            createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
            via: 'rollback',
          })).consent;
        });
      } catch (err: any) {
        if (err?.code === '42501') return problem(c, 403, 'Forbidden', 'Your role may not change this client\'s DNA');
        log.error('[core:clients:rollback] rollback not saved:', err?.message || err);
        return problem(c, 500, 'Database Transaction Failed', 'The rollback could not be saved; try again');
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

    const modelReading = consent && targetId ? await modelReadingOf(auth, targetId, consent) : null;
    return c.json({
      rolledBack: true,
      activeVersion: newVersion,
      revertedToVersion: targetSnap.version,
      activeDna: restoredDna,
      snapshot: rollbackSnap,
      ...(modelReading ? { modelReading } : {}),
    }, 200);
  });

  /**
   * ADR-234: a client's consent to model readings of its messages. An administrator (a person, never
   * a service) makes the next DNA version with only privacy's provider consent changed, approved by
   * them, with an audit row; the GET says what the readers see now, without SQL.
   */
  const consentFailure = (c: any, err: unknown) => {
    if (err instanceof ModelConsentError) return problem(c, err.status, err.code, err.message);
    return problem(c, 503, 'Database Unavailable', (err as Error)?.message || 'Could not read or record the client\'s model consent');
  };
  registerRoute('get', '/clients/:clientId/dna/model-consent', async (c: any) => {
    c.header('Cache-Control', 'no-store');
    if (!db || !clientRepo) return problem(c, 503, 'Database Required', 'Model consent is held in PostgreSQL.');
    try {
      return c.json(await readClientModelConsent(db, clientRepo, verifyRequestAuth(c), c.req.param('clientId')), 200);
    } catch (err) {
      return consentFailure(c, err);
    }
  });
  registerRoute('post', '/clients/:clientId/dna/model-consent', async (c: any) => {
    c.header('Cache-Control', 'no-store');
    if (!db || !clientRepo) return problem(c, 503, 'Database Required', 'Model consent is held in PostgreSQL.');
    try {
      const body = await c.req.json().catch(() => null);
      const result = await recordClientModelConsent(db, clientRepo, verifyRequestAuth(c), c.req.param('clientId'), body);
      const { dna, code, ...answer } = result;
      if (result.changed && !result.replayed) {
        // The map Core still reads (client-dna-hydration.ts), under the three keys it is hydrated with.
        for (const key of [result.clientId, ...(code ? [code, `client-${code}`] : [])]) clientDnas.set(key, dna as unknown as ClientDNA);
        broadcast('dna:updated', { clientId: result.clientId, version: result.version, sha256: result.contentHash });
      }
      return c.json(answer, result.changed && !result.replayed ? 201 : 200);
    } catch (err) {
      return consentFailure(c, err);
    }
  });
}
