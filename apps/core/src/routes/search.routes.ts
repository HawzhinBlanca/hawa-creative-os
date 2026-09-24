import type { RouteContext } from './types.js';
import { globalFeedbackMiner } from '@hawa/creative';
import { VaultSearchEngine, type SearchableItem, type SearchCategory } from '@hawa/retrieval';
import { DEFAULT_CLIENT_ID } from '../core-context.js';

/**
 * GET /search and the index it searches (architecture programme 1.3, G7). Moved from createApp unchanged.
 */
export function registerSearchRoutes(ctx: RouteContext): void {
  const {
    briefs,
    clientDnas,
    problem,
    registerRoute,
    tasks,
    uploadedAssets,
    verifyRequestAuth,
  } = ctx;
  const defaultClientId = DEFAULT_CLIENT_ID;

  // --- Universal Multi-Tenant Search Engine (FR-077, Invariant #6, Gate B & F) ---
  function buildSearchEngine(): VaultSearchEngine {
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
    for (const [taskId, task] of tasks.entries()) {
      const clientId = task.clientId || defaultClientId;
      const client = clientDnas.get(clientId); // search labels only; the hydrated cache is current enough
      const brief = briefs.get(taskId);
      const briefText = brief?.objective || (task as any).title || '';
      engine.indexItem({
        id: taskId,
        category: 'tasks',
        clientId,
        clientName: client?.name,
        title: (task as any).title || `Task ${taskId.slice(0, 8)}`,
        subtitle: `Status: ${task.status} · Phase: ${task.currentPhase || 'INTAKE'}`,
        bodyText: `${briefText} ${(task as any).objective || ''} ${taskId} ${(task as any).tags?.join(' ') || ''}`,
        tags: (task as any).tags || [task.status],
        status: task.status,
        metadata: { currentPhase: task.currentPhase, status: task.status, latestRevisionId: task.latestRevisionId },
        updatedAt: task.updatedAt || new Date().toISOString(),
      });
    }

    // Index clients
    for (const [cId, cData] of clientDnas.entries()) {
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
    for (const [assetId, asset] of uploadedAssets.entries()) {
      const cId = asset.clientId || defaultClientId;
      engine.indexItem({
        id: assetId,
        category: 'assets',
        clientId: cId,
        title: asset.filename || assetId,
        subtitle: `${asset.mimeType} · ${asset.sizeBytes || 1024} B`,
        bodyText: `${asset.filename} ${asset.mimeType} ${asset.category || ''} ${asset.sha256 || ''}`,
        tags: [asset.mimeType, asset.category || 'asset'],
        metadata: { sha256: asset.sha256, storageKey: asset.storageKey },
        updatedAt: asset.createdAt || new Date().toISOString(),
      });
    }

    // Index candidate and promoted rules
    for (const [cId, _] of clientDnas.entries()) {
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

  registerRoute('get', '/search', (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');

    const q = (c.req.query('q') || c.req.query('query') || '').trim();
    const clientId = c.req.query('clientId');
    const category = (c.req.query('category') || 'all') as SearchCategory;
    const limit = parseInt(c.req.query('limit') || '25', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const engine = buildSearchEngine();
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
      clientId: clientId || null,
      results,
      resultsCount: searchRes.total,
      scopeEnforced: Boolean(clientId && clientId !== 'all'),
    }, 200);
  });
}
