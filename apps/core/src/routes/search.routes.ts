import type { RouteContext } from './types.js';
import type { ClientDNA } from '@hawa/domain';
import { API_STATUS_OF_DB_STATE } from '@hawa/contracts';
import { deskReviewPath } from '@hawa/contracts/desk-navigation';
import { globalFeedbackMiner } from '@hawa/creative';
import { VaultSearchEngine, extractSearchTokens, type SearchableItem, type SearchCategory } from '@hawa/retrieval';
import { sql, toApiTaskStatus, withRlsContext } from '@hawa/db';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { listUploadedAssets } from '../services/uploaded-assets.js';
import { log } from '../logging.js';

/** What the search indexes: tasks, clients (keyed by the id a scoped search names) and assets. */
interface Searchable {
  tasks: Array<{ id: string; title?: string; clientId?: string | null; status: string; objective?: string; requestText?: string; currentPhase?: string; latestRevisionId?: string; tags?: string[]; updatedAt?: string }>;
  clients: Array<[string, ClientDNA]>;
  assets: Array<{ assetId: string; clientId?: string; filename?: string; mimeType?: string; category?: string; sha256?: string; storageKey?: string | null; sizeBytes?: number; createdAt?: string }>;
  /** A client's code and `client-<code>` spellings, to its Postgres id. */
  aliases: Map<string, string>;
  /** More tasks are in scope than one search reads (TASK_CEILING); the answer may miss some. */
  truncated: boolean;
}

/** Tasks read per round trip, and at most per search (HAWA_SEARCH_TASK_CEILING overrides the most). */
const TASK_PAGE = 1000;
const TASK_CEILING = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Desk screen for the navigation items the search indexes. */
const NAV_ROUTES: Record<string, string> = {
  'nav-review': '#/review', 'nav-inbox': '#/inbox', 'nav-dna': '#/dna', 'nav-ops': '#/ops', 'nav-eval': '#/eval',
};

/**
 * Where a hit opens in the Desk, or null when no Desk screen shows it. Every hit that was neither a
 * task nor a client opened the generic review page (bug hunt 2026-09-29): a candidate rule is shown
 * on its client's DNA page, a navigation item is its own screen, and an uploaded asset is listed on
 * no Desk screen, so it opens nothing rather than a page without it.
 */
export function searchResultUrl(item: { id: string; category: string; clientId: string }): string | null {
  if (item.category === 'tasks') return deskReviewPath({ taskId: item.id }).slice(1);
  if (item.category === 'clients' || item.category === 'rules') return `#/dna?client=${item.clientId}`;
  return NAV_ROUTES[item.id] ?? null;
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
  async function searchable(auth: { tenantId?: string; userId?: string; role?: string }, requestedClientId?: string, query = ''): Promise<Searchable> {
    if (!db) {
      return {
        tasks: Array.from(tasks.entries()).map(([id, t]) => ({ ...t, id, objective: briefs.get(id)?.objective, requestText: t.description })),
        clients: Array.from(clientDnas.entries()),
        assets: Array.from(uploadedAssets.values()),
        aliases: new Map(),
        truncated: false,
      };
    }
    const scope = { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId || OPERATOR_USER_ID, role: auth.role || 'operator' };
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : undefined);
    const requestedScope = requestedClientId && requestedClientId !== 'all' ? requestedClientId : undefined;
    const clientRows = await withRlsContext(db, scope, async (trx) =>
        (await sql<{ client_id: string; code: string | null; dna: unknown }>`
          SELECT v.client_id, c.code, v.dna FROM hawa.client_dna_versions v
          JOIN hawa.clients c ON c.id = v.client_id AND c.tenant_id = v.tenant_id
          WHERE v.tenant_id = ${scope.tenantId}::uuid AND v.status = 'active'
            ${requestedScope ? sql`AND (c.id::text=${requestedScope} OR c.code=${requestedScope} OR 'client-' || c.code=${requestedScope})` : sql``}`.execute(trx)).rows);
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

    // Every task in scope, newest first, a page at a time. The search read the newest 1,000 of the
    // tenant and filtered them by client and words afterwards, so an older task, or any task of a
    // client whose work was not among the newest 1,000, could not be found (bug hunt 2026-09-29).
    // The words stay with the engine, which scores each task on its own and normalises Sorani and
    // Arabic spellings that SQL would not; client scope and normalized tokens are applied before reading the bounded matches. A task without a client
    // is indexed under the default client, so a search scoped to it reads those.
    const resolved = requestedClientId && requestedClientId !== 'all'
      ? aliases.get(requestedClientId) || requestedClientId : undefined;
    const assets = resolved === undefined ? await listUploadedAssets(db, scope)
      : UUID.test(resolved) ? await listUploadedAssets(db, scope, resolved) : [];
    const clientFilter = resolved === undefined ? sql``
      : resolved === defaultClientId ? sql`AND t.client_id IS NULL`
        : UUID.test(resolved) ? sql`AND t.client_id = ${resolved}::uuid`
          : sql`AND false`;
    const ceiling = Math.max(1, Number(process.env.HAWA_SEARCH_TASK_CEILING) || TASK_CEILING);
    type TaskRow = { id: string; title: string | null; client_id: string | null; state: string; current_design_revision_id: string | null; created_at: Date; updated_at: Date; objective: string | null; request_text: string | null };
    // Match before the bounded read, so an old request cannot disappear behind unrelated new work.
    // Keep the retrieval engine's OR-token semantics and Sorani/Arabic normalization.
    const tokens = extractSearchTokens(query);
    const corpus = sql`concat_ws(' ', t.id::text, t.title, t.description, t.state, ${sql`CASE t.state ${sql.join(Object.entries(API_STATUS_OF_DB_STATE).map(([state, api]) => sql`WHEN ${state} THEN ${api}`), sql` `)} END`}, 'Status Phase INTAKE',
      b.brief::text, source.payload->>'rawRequestText', source.payload->>'copyEn',
      source.payload->>'copyCkb', source.payload->'exactCopy')`;
    const normalized = sql`btrim(regexp_replace(regexp_replace(
      translate(lower(normalize(${corpus}, NFC)), 'كي٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', 'کی01234567890123456789'),
      ${'[\u064B-\u065F\u0670]'}, '', 'g'), ${'[\u200C-\u200F\u202A-\u202E\u2066-\u2069،؛؟]'}, ' ', 'g'))`;
    const wordFilter = tokens.length ? sql`AND (${sql.join(tokens.map(token => sql`strpos(${normalized}, ${token}) > 0`), sql` OR `)})` : sql``;
    const taskRows: TaskRow[] = [];
    let truncated = false;
    let after: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const want = Math.min(TASK_PAGE, ceiling - taskRows.length);
      const page = await withRlsContext(db, scope, async (trx) =>
        (await sql<TaskRow>`
          SELECT t.id, t.title, t.client_id, t.state, t.current_design_revision_id, t.created_at, t.updated_at,
            b.brief->>'objective' AS objective,
            concat_ws(' ', t.description, source.payload->>'rawRequestText', source.payload->>'copyEn',
              source.payload->>'copyCkb', source.payload->'exactCopy') AS request_text
          FROM hawa.tasks t
          LEFT JOIN LATERAL (SELECT brief FROM hawa.design_briefs
            WHERE tenant_id=t.tenant_id AND task_id=t.id ORDER BY version DESC LIMIT 1) b ON true
          LEFT JOIN LATERAL (SELECT payload FROM hawa.outbox_commands
            WHERE tenant_id=t.tenant_id AND aggregate_id=t.id AND command_type='task.created'
            ORDER BY created_at DESC LIMIT 1) source ON true
          WHERE t.tenant_id = ${scope.tenantId}::uuid ${clientFilter} ${wordFilter}
            ${after ? sql`AND (t.created_at, t.id) < (${after.createdAt}, ${after.id}::uuid)` : sql``}
          ORDER BY t.created_at DESC, t.id DESC LIMIT ${want + 1}`.execute(trx)).rows);
      const more = page.length > want;
      taskRows.push(...page.slice(0, want));
      if (!more) break;
      if (taskRows.length >= ceiling) { truncated = true; break; }
      const last = taskRows[taskRows.length - 1];
      after = { createdAt: last.created_at, id: last.id };
    }
    if (truncated) log.warn(`[core:search] more than ${ceiling} matching tasks in scope; the search read the newest ${ceiling} matches`);

    return {
      tasks: taskRows.map((t) => ({
        id: t.id, title: t.title || undefined, clientId: t.client_id, status: toApiTaskStatus(t.state),
        objective: t.objective || undefined, requestText: t.request_text || undefined, latestRevisionId: t.current_design_revision_id || undefined, updatedAt: iso(t.updated_at),
      })),
      clients,
      assets,
      aliases,
      truncated,
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
        bodyText: `${briefText} ${task.requestText || ''} ${taskId} ${task.tags?.join(' ') || ''}`,
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

    const q = (c.req.query('q') || c.req.query('query') || '').trim();
    if (q.length > 512 || extractSearchTokens(q).length > 64) return problem(c,422,'Search Too Long','Use up to 512 characters and 64 search words.');
    const requestedClientId = c.req.query('clientId');
    let state: Searchable;
    try {
      state = await searchable(auth, requestedClientId, q);
    } catch (err) {
      log.error('[core:search] Could not read what to search:', err);
      return problem(c, 503, 'Database Unavailable', 'The search could not read the tasks, clients and assets; try again');
    }

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
      url: searchResultUrl(h.item),
      badge: h.item.status || h.item.category,
    }));

    return c.json({
      ...searchRes,
      clientId: requestedClientId || null,
      results,
      resultsCount: searchRes.total,
      scopeEnforced: Boolean(clientId && clientId !== 'all'),
      truncated: state.truncated,
    }, 200);
  });
}
