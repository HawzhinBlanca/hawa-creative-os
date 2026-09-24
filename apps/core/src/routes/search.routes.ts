import type { RouteContext } from './types.js';
import type { ClientDNA } from '@hawa/domain';
import { globalFeedbackMiner } from '@hawa/creative';
import { VaultSearchEngine, type SearchableItem, type SearchCategory } from '@hawa/retrieval';
import { sql, toApiTaskStatus, withRlsContext } from '@hawa/db';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { listUploadedAssets } from '../services/uploaded-assets.js';
import { log } from '../logging.js';

/** What the search indexes: tasks, clients (keyed by the id a scoped search names) and assets. */
interface Searchable {
  tasks: Array<{ id: string; title?: string; clientId?: string | null; status: string; objective?: string; currentPhase?: string; latestRevisionId?: string; tags?: string[]; updatedAt?: string }>;
  clients: Array<[string, ClientDNA]>;
  assets: Array<{ assetId: string; clientId?: string; filename?: string; mimeType?: string; category?: string; sha256?: string; storageKey?: string | null; sizeBytes?: number; createdAt?: string }>;
  /** A client's code and `client-<code>` spellings, to its Postgres id. */
  aliases: Map<string, string>;
}

/**
 * GET /search and the index it searches (architecture programme 1.3, G7). Moved from createApp unchanged.
 */
export function registerSearchRoutes(ctx: RouteContext): void {
  const {
    briefs,
    clientDnas,
    db,
    problem,
    registerRoute,
    tasks,
    uploadedAssets,
    verifyRequestAuth,
  } = ctx;
  const defaultClientId = DEFAULT_CLIENT_ID;

  /**
   * With a database, the tenant's newest tasks (with their brief's objective), its clients' active
   * DNA and its uploaded assets, as Postgres holds them. The search indexed the tasks and assets this
   * process held in memory and the DNA it loaded at start-up, so the Desk's search found nothing
   * another Core, or this one before a restart, had created. Without a database, the no-database store.
   */
  async function searchable(auth: { tenantId?: string; userId?: string; role?: string }): Promise<Searchable> {
    if (!db) {
      return {
        tasks: Array.from(tasks.entries()).map(([id, t]) => ({ ...t, id, objective: briefs.get(id)?.objective })),
        clients: Array.from(clientDnas.entries()),
        assets: Array.from(uploadedAssets.values()),
        aliases: new Map(),
      };
    }
    const scope = { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId || OPERATOR_USER_ID, role: auth.role || 'operator' };
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : undefined);
    const [taskRows, clientRows, assets] = await Promise.all([
      withRlsContext(db, scope, async (trx) =>
        (await sql<{ id: string; title: string | null; client_id: string | null; state: string; current_design_revision_id: string | null; updated_at: Date; objective: string | null }>`
          SELECT t.id, t.title, t.client_id, t.state, t.current_design_revision_id, t.updated_at,
            (SELECT b.brief->>'objective' FROM hawa.design_briefs b
              WHERE b.tenant_id = t.tenant_id AND b.task_id = t.id ORDER BY b.version DESC LIMIT 1) AS objective
          FROM hawa.tasks t WHERE t.tenant_id = ${scope.tenantId}::uuid
          ORDER BY t.created_at DESC LIMIT 1000`.execute(trx)).rows),
      withRlsContext(db, scope, async (trx) =>
        (await sql<{ client_id: string; code: string | null; dna: unknown }>`
          SELECT v.client_id, c.code, v.dna FROM hawa.client_dna_versions v
          JOIN hawa.clients c ON c.id = v.client_id AND c.tenant_id = v.tenant_id
          WHERE v.tenant_id = ${scope.tenantId}::uuid AND v.status = 'active'`.execute(trx)).rows),
      listUploadedAssets(db, scope),
    ]);
    const aliases = new Map<string, string>();
    const clients: Array<[string, ClientDNA]> = [];
    for (const row of clientRows) {
      const dna = (typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna) as ClientDNA | null;
      if (!dna || typeof dna !== 'object') continue;
      clients.push([row.client_id, dna]);
      if (row.code) {
        aliases.set(row.code, row.client_id);
        aliases.set(`client-${row.code}`, row.client_id);
      }
    }
    return {
      tasks: taskRows.map((t) => ({
        id: t.id, title: t.title || undefined, clientId: t.client_id, status: toApiTaskStatus(t.state),
        objective: t.objective || undefined, latestRevisionId: t.current_design_revision_id || undefined, updatedAt: iso(t.updated_at),
      })),
      clients,
      assets,
      aliases,
    };
  }

  // --- Universal Multi-Tenant Search Engine (FR-077, Invariant #6, Gate B & F) ---
  function buildSearchEngine(state: Searchable): VaultSearchEngine {
    const engine = new VaultSearchEngine();

    // Index navigation items
    const navItems: SearchableItem[] = [
      { id: 'nav-review', category: 'copy', clientId: 'all', title: 'Studio Review & Artboard', subtitle: 'Interactive vector editor and canvas export', bodyText: 'Studio Review Artboard vector editor canvas export #/review', tags: ['Studio', 'Navigation'], updatedAt: new Date().toISOString() },
      { id: 'nav-inbox', category: 'copy', clientId: 'all', title: 'Intake & Task Simulator', subtitle: 'Multi-client inbound requests and pipeline ingress', bodyText: 'Intake Task Simulator inbound requests pipeline ingress #/', tags: ['Inbox', 'Navigation'], updatedAt: new Date().toISOString() },
      { id: 'nav-dna', category: 'copy', clientId: 'all', title: 'Client DNA & Brand Governance', subtitle: 'Brand kits, fonts, and governed rule promotion', bodyText: 'Client DNA Brand Governance fonts rules brand kits #/dna', tags: ['DNA', 'Navigation'], updatedAt: new Date().toISOString() },
      { id: 'nav-ops', category: 'copy', clientId: 'all', title: 'Operations & AI Cost Budgets', subtitle: 'Adapter health, financial quotas, and recovery metrics', bodyText: 'Operations AI Cost Budgets Adapter health quotas recovery metrics #/ops', tags: ['Ops', 'Navigation'], updatedAt: new Date().toISOString() },
      { id: 'nav-eval', category: 'copy', clientId: 'all', title: 'AI Model Tournaments & Evals', subtitle: 'Leaderboard, retrieval scoring, and redteam tests', bodyText: 'AI Model Tournaments Evals Leaderboard retrieval scoring redteam #/eval', tags: ['Evals', 'Navigation'], updatedAt: new Date().toISOString() },
    ];
    for (const item of navItems) engine.indexItem(item);

    // Index tasks
    const clientNames = new Map(state.clients.map(([id, dna]) => [id, dna.name]));
    for (const task of state.tasks) {
      const taskId = task.id;
      const clientId = task.clientId || defaultClientId;
      const briefText = task.objective || task.title || '';
      engine.indexItem({
        id: taskId,
        category: 'tasks',
        clientId,
        clientName: clientNames.get(clientId),
        title: task.title || `Task ${taskId.slice(0, 8)}`,
        subtitle: `Status: ${task.status} · Phase: ${task.currentPhase || 'INTAKE'}`,
        bodyText: `${briefText} ${taskId} ${task.tags?.join(' ') || ''}`,
        tags: task.tags || [task.status],
        status: task.status,
        metadata: { currentPhase: task.currentPhase, status: task.status, latestRevisionId: task.latestRevisionId },
        updatedAt: task.updatedAt || new Date().toISOString(),
      });
    }

    // Index clients
    for (const [cId, cData] of state.clients) {
      const primaryHex = cData.colors?.find((c) => c.role === 'primary')?.hex || '#0B192C';
      const voice = cData.guidelines?.voiceAndTone || 'luxury';
      engine.indexItem({
        id: cId,
        category: 'clients',
        clientId: cId,
        clientName: cData.name,
        title: cData.name || cId,
        subtitle: `Code: ${cData.code} · Tone: ${voice}`,
        bodyText: `${cData.name} ${cData.code} ${voice} ${(cData.guidelines?.prohibitedPhrases || []).join(' ')} ${cId}`,
        tags: [cData.defaultLocale, cData.status],
        metadata: { version: cData.version, primaryHex },
        updatedAt: cData.updatedAt || new Date().toISOString(),
      });
    }

    // Index assets
    for (const asset of state.assets) {
      const assetId = asset.assetId;
      const cId = asset.clientId || defaultClientId;
      engine.indexItem({
        id: assetId,
        category: 'assets',
        clientId: cId,
        title: asset.filename || assetId,
        subtitle: `${asset.mimeType} · ${asset.sizeBytes || 1024} B`,
        bodyText: `${asset.filename} ${asset.mimeType} ${asset.category || ''} ${asset.sha256 || ''}`,
        tags: [asset.mimeType || 'unknown', asset.category || 'asset'],
        metadata: { sha256: asset.sha256, storageKey: asset.storageKey },
        updatedAt: asset.createdAt || new Date().toISOString(),
      });
    }

    // Index candidate and promoted rules
    for (const [cId] of state.clients) {
      const rules = globalFeedbackMiner.getCandidateRules(cId);
      for (const rule of rules) {
        engine.indexItem({
          id: rule.id,
          category: 'rules',
          clientId: cId,
          title: rule.title,
          subtitle: `Confidence: ${Math.round(rule.confidence * 100)}% · Freq: ${rule.frequency}`,
          bodyText: `${rule.title} ${rule.ruleText} ${rule.category} ${rule.rationale}`,
          tags: [rule.category, rule.status],
          metadata: { confidence: rule.confidence, frequency: rule.frequency },
          updatedAt: rule.promotedAt || new Date().toISOString(),
        });
      }
    }

    return engine;
  }

  registerRoute('get', '/search', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');

    let state: Searchable;
    try {
      state = await searchable(auth);
    } catch (err) {
      log.error('[core:search] Could not read what to search:', err);
      return problem(c, 503, 'Database Unavailable', 'The search could not read the tasks, clients and assets; try again');
    }

    const q = (c.req.query('q') || c.req.query('query') || '').trim();
    const requestedClientId = c.req.query('clientId');
    // A client named by its code is searched by its Postgres id, which is what the items carry.
    const clientId = requestedClientId ? state.aliases.get(requestedClientId) || requestedClientId : requestedClientId;
    const category = (c.req.query('category') || 'all') as SearchCategory;
    const limit = parseInt(c.req.query('limit') || '25', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const engine = buildSearchEngine(state);
    const searchRes = engine.search({
      q,
      clientId: clientId && clientId !== 'all' ? clientId : undefined,
      category,
      limit,
      offset,
    });

    const results = searchRes.hits.map((h) => ({
      id: h.item.id,
      category: h.item.category.toUpperCase(),
      title: h.item.title,
      subtitle: h.item.subtitle || h.snippet,
      url:
        h.item.category === 'tasks'
          ? `#/review?taskId=${h.item.id}`
          : h.item.category === 'clients'
            ? `#/dna?client=${h.item.clientId}`
            : `#/review`,
      badge: h.item.status || h.item.category,
    }));

    return c.json({
      ...searchRes,
      clientId: requestedClientId || null,
      results,
      resultsCount: searchRes.total,
      scopeEnforced: Boolean(clientId && clientId !== 'all'),
    }, 200);
  });
}
